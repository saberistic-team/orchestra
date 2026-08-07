import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedCompletionTokens,
  hydrateAddressedArtifacts,
  ollamaInference,
  ollamaProviderInference,
  promptTokenUpperBound,
  parseOpenRouterUsage,
  resolveInferencePolicy,
  resolveOpenRouterRequestPolicy,
} from './activities.js';
import type { OllamaInferenceRequest } from './model-protocol.js';
import {
  configureBudgetPriorStore,
  createMemoryBudgetPriorStore,
} from './openrouter-budget-learning.js';

const request: OllamaInferenceRequest = {
  role: 'requirements',
  purpose: 'generate',
  round: 0,
  temperature: 0.2,
  messages: [
    { role: 'system', content: 'Follow the artifact contract.' },
    { role: 'user', content: 'Define the MVP.' },
  ],
};

let server: Server | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  configureBudgetPriorStore(undefined);
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
    server = undefined;
  });
});

async function listen(handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listen address.');
  return address.port;
}

describe('addressed artifact hydration', () => {
  it('resolves content inside the provider Activity without changing the transported reference', async () => {
    const content = '# Requirements\n\nKeep the existing API.';
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const addressedRequest = {
      ...request,
      provider: 'ollama' as const,
      model: 'qwen3.5:9b',
      artifactReferences: [{
        id: 'artifact-1',
        type: 'requirements-baseline',
        name: 'Requirements baseline',
        version: 2,
        mimeType: 'text/markdown',
        producedBy: 'requirements' as const,
        contentAddress: 'orchestra-artifact://postgres/project-1/artifact-1?version=2',
        contentHash: digest,
        byteLength: Buffer.byteLength(content, 'utf8'),
        repositoryPath: 'artifacts/requirements.md',
        repositoryUrl: 'https://forgejo.example/artifacts/requirements.md',
      }],
    };
    const loader = vi.fn(async () => ({ content, version: 2, mimeType: 'text/markdown' }));

    const hydrated = await hydrateAddressedArtifacts(addressedRequest, loader);

    expect(loader).toHaveBeenCalledWith('project-1', 'artifact-1', 2);
    expect(addressedRequest.messages.at(-1)?.content).toBe('Define the MVP.');
    expect(hydrated.messages.at(-1)?.content).toContain(content);
    expect(hydrated.artifactReferences).toEqual(addressedRequest.artifactReferences);
  });
});

describe('Ollama inference Activity boundary', () => {
  it('caps local generation and its HTTP lifetime to the remaining call budget', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'ollama');
    let body = '';
    const boundedRequest = {
      ...request,
      provider: 'ollama' as const,
      model: 'requirements-model:latest',
      inferenceBudget: {
        maxTotalTokens: 1_000,
        maxCost: 0,
        deadlineEpochMs: Date.now() + 10_000,
      },
    };
    const port = await listen((req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        expect(JSON.parse(body)).toMatchObject({
          options: {
            temperature: request.temperature,
            num_predict: boundedCompletionTokens(boundedRequest, 131_072),
          },
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          message: { content: '{"ok":true}' },
          prompt_eval_count: 30,
          eval_count: 10,
        }));
      });
    });
    vi.stubEnv('OLLAMA_HOST', `http://127.0.0.1:${port}`);

    await expect(ollamaProviderInference(boundedRequest)).resolves.toMatchObject({
      provider: 'ollama',
      usage: { totalTokens: 40 },
    });
  });

  it('performs one role-model request and returns only its model output', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_MODEL_REQUIREMENTS', 'requirements-model:latest');
    let body = '';
    const port = await listen((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/chat');
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        expect(JSON.parse(body)).toMatchObject({
          model: 'requirements-model:latest',
          stream: false,
          format: 'json',
          options: { temperature: 0.2 },
          messages: request.messages,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          message: { content: '{"content":"# Requirements"}' },
          prompt_eval_count: 13,
          eval_count: 8,
        }));
      });
    });
    vi.stubEnv('OLLAMA_HOST', `http://127.0.0.1:${port}`);

    await expect(ollamaProviderInference({ ...request, provider: 'ollama', model: 'requirements-model:latest' })).resolves.toEqual({
      provider: 'ollama',
      model: 'requirements-model:latest',
      content: '{"content":"# Requirements"}',
      usage: { promptTokens: 13, completionTokens: 8, totalTokens: 21 },
    });
  });

  it('surfaces HTTP failures and empty model responses', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'ollama');
    let calls = 0;
    const port = await listen((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(503);
        res.end('');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: {} }));
    });
    vi.stubEnv('OLLAMA_HOST', `http://127.0.0.1:${port}`);

    await expect(ollamaInference(request)).rejects.toThrow('Ollama returned 503');
    await expect(ollamaInference(request)).rejects.toThrow('returned no content');
  });

  it('keeps waiting past undici\'s 5-minute headersTimeout default when the model is slow to respond', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'ollama');
    vi.stubEnv('MODEL_TIMEOUT_MS', '');
    vi.stubEnv('OLLAMA_TIMEOUT_MS', '50');
    const port = await listen((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { content: '{"ok":true}' } }));
      }, 20);
    });
    vi.stubEnv('OLLAMA_HOST', `http://127.0.0.1:${port}`);

    await expect(ollamaInference(request)).resolves.toEqual({
      provider: 'ollama',
      model: process.env.OLLAMA_MODEL_DEFAULT ?? 'qwen3.5:9b',
      content: '{"ok":true}',
    });
  });

  it('fails with an explicit timeout when OLLAMA_TIMEOUT_MS elapses before headers', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_TIMEOUT_MS', '30');
    const port = await listen((_req, _res) => {
      // Never respond; the Activity must abort via OLLAMA_TIMEOUT_MS.
    });
    vi.stubEnv('OLLAMA_HOST', `http://127.0.0.1:${port}`);

    await expect(ollamaInference(request)).rejects.toThrow(/timed out after 30ms/);
  });
});

describe('OpenRouter inference Activity boundary', () => {
  it('allows one accounted retry while preserving token and worst-case price caps', () => {
    const deadlineEpochMs = Date.now() + 60_000;
    const bounded = {
      ...request,
      provider: 'openrouter' as const,
      model: 'qwen/qwen3.5-27b',
      inferenceBudget: { maxTotalTokens: 1_000, maxCost: 0.01, deadlineEpochMs },
    };
    const policy = resolveOpenRouterRequestPolicy(bounded, { OPENROUTER_HTTP_ATTEMPTS: '5' });

    expect(promptTokenUpperBound(bounded)).toBeLessThan(1_000);
    expect(policy).toMatchObject({
      maxTokens: 1_000 - promptTokenUpperBound(bounded),
      retryMaxTokens: 1_000 - promptTokenUpperBound(bounded),
      attempts: 2,
      provider: {
        allow_fallbacks: false,
        max_price: { prompt: 10, completion: 10, request: 0 },
      },
    });
    expect(policy.timeoutMs).toBeGreaterThan(0);
    expect(policy.timeoutMs).toBeLessThanOrEqual(60_000);
  });

  it('posts OpenAI-compatible chat completions with the role model', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_MODEL_REQUIREMENTS', 'qwen/qwen3.5-27b');
    let body = '';
    let auth = '';
    const port = await listen((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/v1/chat/completions');
      auth = String(req.headers.authorization ?? '');
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        expect(JSON.parse(body)).toMatchObject({
          model: 'qwen/qwen3.5-27b',
          temperature: 0.2,
          max_tokens: 4096,
          reasoning: { max_tokens: 512, exclude: true },
          provider: {
            sort: 'throughput',
            allow_fallbacks: true,
            require_parameters: true,
            preferred_min_throughput: { p50: 30 },
          },
          response_format: { type: 'json_object' },
          stream: true,
          stream_options: { include_usage: true },
          messages: request.messages,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'generation-123',
          model: 'qwen/qwen3.5-27b',
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.002 },
          choices: [{ message: { content: '{"content":"# Requirements"}' } }],
        }));
      });
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).resolves.toEqual({
      provider: 'openrouter',
      model: 'qwen/qwen3.5-27b',
      content: '{"content":"# Requirements"}',
      requestId: 'generation-123',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cost: 0.002 },
    });
    expect(auth).toBe('Bearer test-key');
    await expect(resolveInferencePolicy()).resolves.toMatchObject({
      provider: 'openrouter',
      serialize: false,
      concurrency: 8,
    });
  });

  it('uses bounded role and purpose budgets with scoped overrides', () => {
    const manager = { ...request, role: 'manager', provider: 'openrouter', model: 'manager-model' } as const;
    expect(resolveOpenRouterRequestPolicy(manager, {})).toMatchObject({
      maxTokens: 4096,
      retryMaxTokens: 8192,
      reasoningTokens: 512,
      hardMaxTokens: 16384,
      budgetBumps: 2,
      timeoutMs: 240000,
      attempts: 2,
      provider: { sort: 'latency', require_parameters: false },
    });
    expect(resolveOpenRouterRequestPolicy({
      ...manager,
      role: 'builder',
      model: 'qwen/qwen3-coder',
    }, {})).toMatchObject({
      maxTokens: 12288,
      reasoningTokens: 1536,
      hardMaxTokens: 32768,
      timeoutMs: 600000,
      provider: { sort: 'throughput', require_parameters: false },
    });
    expect(resolveOpenRouterRequestPolicy({ ...manager, role: 'test' }, {})).toMatchObject({
      maxTokens: 4096,
      reasoningTokens: 512,
      provider: { sort: 'throughput', require_parameters: false },
    });
    expect(resolveOpenRouterRequestPolicy({
      ...manager,
      role: 'product',
      model: 'openai/gpt-5-mini',
    }, {})).toMatchObject({
      maxTokens: 4096,
      reasoningTokens: 512,
      hardMaxTokens: 32768,
      provider: { sort: 'latency', require_parameters: false },
    });
    expect(resolveOpenRouterRequestPolicy({
      ...manager,
      role: 'reviewer',
      model: 'anthropic/claude-sonnet-4.6',
    }, {})).toMatchObject({
      maxTokens: 4096,
      reasoningTokens: 0,
      hardMaxTokens: 16384,
      hardReasoningTokens: 0,
      timeoutMs: 240000,
      provider: { sort: 'latency', require_parameters: false },
    });
    expect(resolveOpenRouterRequestPolicy({
      ...manager,
      role: 'validation',
      model: 'openai/gpt-5-mini',
    }, {})).toMatchObject({ maxTokens: 4096, reasoningTokens: 512, timeoutMs: 240000 });
    expect(resolveOpenRouterRequestPolicy({ ...manager, role: 'reviewer', purpose: 'quality_review' }, {})).toMatchObject({
      maxTokens: 2048,
      retryMaxTokens: 4096,
      reasoningTokens: 0,
      timeoutMs: 120000,
      provider: {
        sort: 'latency',
        require_parameters: false,
        preferred_max_latency: { p90: 5 },
      },
    });
    expect(resolveOpenRouterRequestPolicy({
      ...manager,
      role: 'reviewer',
      purpose: 'quality_review',
      model: 'openai/gpt-5-mini',
    }, {})).toMatchObject({ maxTokens: 2048, reasoningTokens: 256 });
    expect(resolveOpenRouterRequestPolicy(manager, {
      OPENROUTER_MAX_TOKENS_MANAGER_GENERATE: '2048',
      OPENROUTER_REASONING_MAX_TOKENS_GENERATE: '512',
      OPENROUTER_TIMEOUT_MS: '180000',
    })).toMatchObject({ maxTokens: 2048, reasoningTokens: 512, timeoutMs: 180000 });
    for (const [purpose, maxTokens, retryMaxTokens] of [
      ['plan', 3072, 4096],
      ['plan_repair', 4096, 8192],
      ['progress_assessment', 1536, 3072],
      ['completion_assessment', 1536, 3072],
    ] as const) {
      expect(resolveOpenRouterRequestPolicy({ ...manager, purpose }, {})).toMatchObject({
        maxTokens,
        retryMaxTokens,
        reasoningTokens: 256,
        timeoutMs: 120000,
        provider: { sort: 'latency' },
      });
    }
    expect(resolveOpenRouterRequestPolicy({ ...manager, purpose: 'plan_repair' }, {
      OPENROUTER_MAX_TOKENS_MANAGER_PLAN_REPAIR: '1536',
      OPENROUTER_REASONING_MAX_TOKENS_PLAN_REPAIR: '256',
    })).toMatchObject({ maxTokens: 1536, reasoningTokens: 256 });
    expect(resolveOpenRouterRequestPolicy(manager, {
      OPENROUTER_MAX_TOKENS: '100000',
      OPENROUTER_MAX_TOKENS_HARD_LIMIT: '8192',
    })).toMatchObject({ maxTokens: 8192, hardMaxTokens: 8192 });
    expect(resolveOpenRouterRequestPolicy({
      ...manager,
      role: 'builder',
      model: 'qwen/qwen3-coder',
    }, {
      OPENROUTER_BUDGET_LEARNING: 'true',
      OPENROUTER_BUDGET_HEADROOM: '1.35',
    }, {
      prior: {
        promptEwma: 1_000,
        completionEwma: 10_000,
        reasoningEwma: 2_000,
        samples: 3,
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    })).toMatchObject({
      maxTokens: Math.ceil(10_000 * 1.35),
      reasoningTokens: Math.ceil(2_000 * 1.35),
    });
    expect(parseOpenRouterUsage({
      prompt_tokens: 11,
      completion_tokens: 40,
      total_tokens: 51,
      cost: 0.01,
      completion_tokens_details: { reasoning_tokens: 12 },
    })).toEqual({
      promptTokens: 11,
      completionTokens: 40,
      reasoningTokens: 12,
      totalTokens: 51,
      cost: 0.01,
    });
  });

  it('assembles streaming OpenRouter chunks and returns final usage', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"stream-1","model":"qwen/test","choices":[{"delta":{"content":"{\\"content\\":\\"# "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Requirements\\"}"},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18,"cost":0.001}}\n\n');
      res.end('data: [DONE]\n\n');
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).resolves.toEqual({
      provider: 'openrouter',
      model: 'qwen/test',
      content: '{"content":"# Requirements"}',
      requestId: 'stream-1',
      usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18, cost: 0.001 },
    });
  });

  it('allows bounded SSE metadata overhead without loosening the final content cap', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('MODEL_MAX_RESPONSE_BYTES', '200');
    vi.stubEnv('OPENROUTER_MAX_STREAM_BYTES', '5000');
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        id: 'metadata-heavy',
        choices: [{
          delta: { content: '{"content":"Bounded"}' },
          reasoning_details: 'x'.repeat(1_000),
        }],
      })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).resolves.toMatchObject({
      requestId: 'metadata-heavy',
      content: '{"content":"Bounded"}',
    });
  });

  it('still rejects assembled streaming content beyond the final response cap', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('MODEL_MAX_RESPONSE_BYTES', '100');
    vi.stubEnv('OPENROUTER_MAX_STREAM_BYTES', '5000');
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'x'.repeat(101) } }],
      })}\n\n`);
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).rejects.toThrow('OpenRouter content exceeded 100 bytes.');
  });

  it('requires an API key for OpenRouter', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await expect(ollamaInference(request)).rejects.toThrow('OPENROUTER_API_KEY is required');
  });

  it('honors Retry-After for a bounded transient response', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    let calls = 0;
    const port = await listen((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { 'retry-after': '0' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).resolves.toMatchObject({ provider: 'openrouter', content: '{"ok":true}' });
    expect(calls).toBe(2);
  });

  it('caps a budgeted provider call at one explicitly accounted retry', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_HTTP_ATTEMPTS', '5');
    let calls = 0;
    const port = await listen((_req, res) => {
      calls += 1;
      res.writeHead(429, { 'retry-after': '0' });
      res.end('{}');
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference({
      ...request,
      inferenceBudget: {
        maxTotalTokens: 10_000,
        maxCost: 1,
        deadlineEpochMs: Date.now() + 10_000,
      },
    })).rejects.toThrow('OpenRouter returned 429');
    expect(calls).toBe(2);
  });

  it('retries a definitive provider error emitted before streaming content', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_HTTP_ATTEMPTS', '2');
    let calls = 0;
    const port = await listen((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (calls === 1) {
        res.end('data: {"error":{"code":524,"message":"Provider timed out after 10886ms","metadata":{"provider_name":"Example"}}}\n\n');
        return;
      }
      res.end([
        'data: {"id":"recovered","choices":[{"delta":{"content":"{\\"content\\":\\"Recovered\\"}"},"finish_reason":"stop"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'));
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).resolves.toMatchObject({
      provider: 'openrouter',
      requestId: 'recovered',
      content: '{"content":"Recovered"}',
    });
    expect(calls).toBe(2);
  });

  it('does not retry a streaming provider error after content has begun', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_HTTP_ATTEMPTS', '2');
    let calls = 0;
    const port = await listen((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      res.end('data: {"error":{"code":524,"message":"Provider timed out","metadata":{"provider_name":"Example"}}}\n\n');
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).rejects.toThrow(
      'Provider timed out (code=524, metadata={"provider_name":"Example"})',
    );
    expect(calls).toBe(1);
  });

  it('retries a definitive empty completion and keeps the agent request active', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_HTTP_ATTEMPTS', '2');
    let calls = 0;
    const requestedMaxTokens: number[] = [];
    const port = await listen((req, res) => {
      calls += 1;
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requestedMaxTokens.push(Number((JSON.parse(body) as { max_tokens: number }).max_tokens));
        res.writeHead(200, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify(calls === 1 ? {
          id: 'empty-generation',
          usage: { prompt_tokens: 100, completion_tokens: 3072, total_tokens: 3172, cost: 0.001 },
          choices: [{ finish_reason: 'length', message: { content: '' } }],
        } : {
          id: 'recovered-generation',
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, cost: 0.001 },
          choices: [{ finish_reason: 'stop', message: { content: '{"revised":true}' } }],
        }));
      });
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference({ ...request, purpose: 'plan' })).resolves.toMatchObject({
      provider: 'openrouter',
      requestId: 'recovered-generation',
      content: '{"revised":true}',
    });
    expect(calls).toBe(2);
    expect(requestedMaxTokens).toEqual([3072, 4096]);
  });

  it('reports safe provider metadata after all empty-completion retries are exhausted', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_HTTP_ATTEMPTS', '2');
    vi.stubEnv('OPENROUTER_BUDGET_BUMPS', '0');
    let calls = 0;
    const port = await listen((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({
        id: `empty-${calls}`,
        usage: { completion_tokens: 8192, total_tokens: 9000 },
        choices: [{ finish_reason: 'length', native_finish_reason: 'max_tokens', message: { content: ' ' } }],
      }));
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference({ ...request, purpose: 'revise' })).rejects.toThrow(
      /after 2 attempts \(requestId=empty-2, finishReason=length, nativeFinishReason=max_tokens, completionTokens=8192, totalTokens=9000, budgetAttempt=0, maxTokens=4096, reasoningTokens=512\)/,
    );
    expect(calls).toBe(2);
  });

  it('bumps max_tokens after a length cutoff and retries', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_BUDGET_BUMPS', '2');
    const maxTokens: number[] = [];
    const port = await listen((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { max_tokens?: number };
        maxTokens.push(parsed.max_tokens ?? 0);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (maxTokens.length === 1) {
          res.end(JSON.stringify({
            id: 'cut-1',
            choices: [{ finish_reason: 'length', message: { content: '{"content":"partial' } }],
          }));
          return;
        }
        res.end(JSON.stringify({
          id: 'cut-2',
          choices: [{ finish_reason: 'stop', message: { content: '{"content":"complete"}' } }],
        }));
      });
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).resolves.toMatchObject({
      requestId: 'cut-2',
      content: '{"content":"complete"}',
    });
    expect(maxTokens[0]).toBe(4096);
    expect(maxTokens[1]).toBeGreaterThan(4096);
  });

  it('bumps after truncated JSON without a length finish reason', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_BUDGET_BUMPS', '1');
    let calls = 0;
    const port = await listen((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(calls === 1 ? {
        choices: [{ finish_reason: 'stop', message: { content: '{"content":' } }],
      } : {
        choices: [{ finish_reason: 'stop', message: { content: '{"content":"ok"}' } }],
      }));
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).resolves.toMatchObject({ content: '{"content":"ok"}' });
    expect(calls).toBe(2);
  });

  it('records successful usage into the budget prior store and raises later starts', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_BUDGET_LEARNING', 'true');
    vi.stubEnv('OPENROUTER_BUDGET_HEADROOM', '1.35');
    const store = createMemoryBudgetPriorStore();
    configureBudgetPriorStore(store);
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'learned-1',
        usage: {
          prompt_tokens: 900,
          completion_tokens: 5_000,
          total_tokens: 5_900,
          completion_tokens_details: { reasoning_tokens: 400 },
        },
        choices: [{ finish_reason: 'stop', message: { content: '{"content":"learned"}' } }],
      }));
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).resolves.toMatchObject({
      usage: { promptTokens: 900, completionTokens: 5_000, reasoningTokens: 400 },
    });
    const entries = [...store.snapshot().entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toMatch(/^orchestra:openrouter-budget:requirements:generate:/);
    expect(entries[0]?.[1]).toMatchObject({
      samples: 1,
      completionEwma: 4_600,
      reasoningEwma: 400,
    });
    const learnedModel = entries[0]![0].replace('orchestra:openrouter-budget:requirements:generate:', '');
    expect(resolveOpenRouterRequestPolicy({
      ...request,
      provider: 'openrouter',
      model: learnedModel,
    }, {
      OPENROUTER_BUDGET_LEARNING: 'true',
      OPENROUTER_BUDGET_HEADROOM: '1.35',
    }, { prior: entries[0]![1] })).toMatchObject({
      maxTokens: Math.ceil(4_600 * 1.35),
      reasoningTokens: Math.max(512, Math.ceil(400 * 1.35)),
    });
  });

  it('keeps heuristic starts when the prior store is unavailable', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_BUDGET_LEARNING', 'true');
    // No REDIS_URL and no injected store → learning is a no-op.
    configureBudgetPriorStore(undefined);
    const maxTokens: number[] = [];
    const port = await listen((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        maxTokens.push((JSON.parse(body) as { max_tokens?: number }).max_tokens ?? 0);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"content":"ok"}' } }],
        }));
      });
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).resolves.toMatchObject({ content: '{"content":"ok"}' });
    expect(maxTokens[0]).toBe(4096);
  });

  it('fails clearly when incomplete output reaches the hard token limit', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_ALLOW_REMOTE_DATA', 'true');
    vi.stubEnv('OPENROUTER_MAX_TOKENS', '2048');
    vi.stubEnv('OPENROUTER_MAX_TOKENS_HARD_LIMIT', '2048');
    vi.stubEnv('OPENROUTER_BUDGET_BUMPS', '2');
    let calls = 0;
    const port = await listen((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `hard-${calls}`,
        choices: [{ finish_reason: 'length', message: { content: '{"content":' } }],
      }));
    });
    vi.stubEnv('OPENROUTER_BASE_URL', `http://127.0.0.1:${port}/api/v1`);

    await expect(ollamaInference(request)).rejects.toThrow(/exhausted token budgets.*hardMaxTokens=2048/);
    expect(calls).toBe(1);
  });
});
