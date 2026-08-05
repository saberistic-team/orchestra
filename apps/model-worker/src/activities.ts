import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  agentModelTaskQueue,
  resolveInferenceRoutingPolicy,
  type AgentArtifactDraft,
  type AgentExecutionInput,
  type InferenceRoutingPolicy,
} from '@orchestra/contracts';
import { ProjectStore } from '@orchestra/database';
import { activityInfo, cancellationSignal, heartbeat } from '@temporalio/activity';
import { type Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import {
  assertModelInferenceBudget,
  remainingModelInferenceDeadlineMs,
  type BoundInferenceRequest,
  type ModelInferenceBudget,
  type ModelTokenUsage,
  type OllamaInferenceRequest,
  type OllamaInferenceResult,
} from './model-protocol.js';

let modelWorkflowClient: Client | undefined;
let artifactStore: ProjectStore | undefined;

function addressedArtifactStore() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required to resolve addressed artifact content.');
  artifactStore ??= new ProjectStore(connectionString);
  return artifactStore;
}

type ArtifactContentLoader = (
  projectId: string,
  artifactId: string,
  version: number,
) => Promise<{ content: string; version: number; mimeType: string } | undefined>;

const loadArtifactContent: ArtifactContentLoader = (projectId, artifactId, version) =>
  addressedArtifactStore().artifactContent(projectId, artifactId, version);

export async function hydrateAddressedArtifacts(
  request: BoundInferenceRequest,
  loader: ArtifactContentLoader = loadArtifactContent,
): Promise<BoundInferenceRequest> {
  const references = request.artifactReferences ?? [];
  if (references.length === 0) return request;
  const maximumBytes = positiveInteger(
    process.env.MODEL_MAX_ARTIFACT_CONTEXT_BYTES,
    1_500_000,
    10_000_000,
    'MODEL_MAX_ARTIFACT_CONTEXT_BYTES',
  );
  let totalBytes = 0;
  const bodies: string[] = [];
  for (const reference of references.slice(0, 40)) {
    let content = reference.content;
    if (!content) {
      const address = new URL(reference.contentAddress);
      if (address.protocol !== 'orchestra-artifact:' || address.hostname !== 'postgres') {
        throw new Error(`Unsupported artifact content address ${reference.contentAddress}.`);
      }
      const [projectId, artifactId] = address.pathname.split('/').filter(Boolean);
      const version = Number(address.searchParams.get('version'));
      if (!projectId || !artifactId || !Number.isSafeInteger(version) || version <= 0) {
        throw new Error(`Invalid artifact content address ${reference.contentAddress}.`);
      }
      const stored = await loader(projectId, artifactId, version);
      if (!stored) throw new Error(`Artifact content address ${reference.contentAddress} was not found.`);
      content = stored.content;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    totalBytes += bytes;
    if (totalBytes > maximumBytes) {
      throw new Error(`Addressed artifact context exceeded ${maximumBytes} bytes; narrow the requested evidence set.`);
    }
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (reference.contentHash && reference.contentHash !== digest) {
      throw new Error(`Artifact content digest mismatch for ${reference.contentAddress}.`);
    }
    bodies.push(`<ARTIFACT name=${JSON.stringify(reference.name)} type=${JSON.stringify(reference.type)} producer=${JSON.stringify(reference.producedBy)} address=${JSON.stringify(reference.contentAddress)} digest=${JSON.stringify(digest)}>\n${content}\n</ARTIFACT>`);
  }
  const lastUserIndex = request.messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex < 0) throw new Error('Addressed artifact hydration requires a user message.');
  const messages = request.messages.map((message, index) => index === lastUserIndex
    ? { ...message, content: `${message.content}\n\n<RESOLVED_ARTIFACT_CONTENTS>\n${bodies.join('\n\n')}\n</RESOLVED_ARTIFACT_CONTENTS>` }
    : message);
  return { ...request, messages };
}

/** Configured by the worker process so the legacy Activity can bridge to the new Workflow topology. */
export function configureModelWorkflowClient(client: Client) {
  modelWorkflowClient = client;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, name: string) {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, maximum: number, name: string) {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return parsed;
}

function inferenceTimeoutMs(provider: 'ollama' | 'openrouter') {
  const providerValue = provider === 'openrouter'
    ? process.env.OPENROUTER_TIMEOUT_MS
    : process.env.OLLAMA_TIMEOUT_MS;
  return positiveInteger(process.env.MODEL_TIMEOUT_MS?.trim() || providerValue, 1_500_000, 1_800_000, 'Model timeout');
}

const openRouterRoleDefaults: Record<BoundInferenceRequest['role'], {
  maxTokens: number;
  reasoningTokens: number;
  timeoutMs: number;
}> = {
  manager: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 240_000 },
  requirements: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 240_000 },
  product: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 240_000 },
  ux: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 240_000 },
  architecture: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 300_000 },
  data: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 300_000 },
  security: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 300_000 },
  planner: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 300_000 },
  builder: { maxTokens: 12_288, reasoningTokens: 1_536, timeoutMs: 600_000 },
  test: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 300_000 },
  reviewer: { maxTokens: 4_096, reasoningTokens: 0, timeoutMs: 240_000 },
  gate: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 300_000 },
  deployment: { maxTokens: 3_072, reasoningTokens: 512, timeoutMs: 300_000 },
  validation: { maxTokens: 4_096, reasoningTokens: 512, timeoutMs: 240_000 },
};

export interface OpenRouterRequestPolicy {
  maxTokens: number;
  retryMaxTokens: number;
  reasoningTokens: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  attempts: number;
  provider: {
    sort: 'latency' | 'throughput';
    allow_fallbacks: boolean;
    require_parameters: boolean;
    preferred_max_latency?: { p90: number };
    preferred_min_throughput?: { p50: number };
    max_price?: {
      /** OpenRouter max_price token fields are dollars per million tokens. */
      prompt: number;
      completion: number;
      /** Zero excludes endpoints that add an unbounded per-request charge. */
      request: 0;
    };
  };
}

function boundedDeadlineMs(
  budget: ModelInferenceBudget | undefined,
  configuredTimeoutMs: number,
  nowEpochMs = Date.now(),
) {
  if (!budget) return configuredTimeoutMs;
  const remainingMs = remainingModelInferenceDeadlineMs(budget, nowEpochMs);
  if (remainingMs <= 0) throw new Error('Inference deadline elapsed before the provider request started.');
  return Math.max(1, Math.min(configuredTimeoutMs, remainingMs));
}

/**
 * UTF-8 bytes are a conservative upper bound for content tokens in the byte
 * tokenizers used by the routed chat models. The fixed allowance covers chat
 * framing and special tokens without relying on provider-specific tokenizers.
 */
export function promptTokenUpperBound(request: Pick<BoundInferenceRequest, 'messages'>) {
  return 128 + request.messages.reduce(
    (total, message) => total + 32 + Buffer.byteLength(message.content, 'utf8'),
    0,
  );
}

export function boundedCompletionTokens(
  request: BoundInferenceRequest,
  configuredMaximum: number,
) {
  const budget = request.inferenceBudget;
  if (!budget) return configuredMaximum;
  assertModelInferenceBudget(budget);
  const available = budget.maxTotalTokens - promptTokenUpperBound(request);
  if (available <= 0) {
    throw new Error('Inference token budget cannot cover the bounded prompt envelope.');
  }
  return Math.min(configuredMaximum, available);
}

function boundedOpenRouterMaxPrice(budget: ModelInferenceBudget) {
  if (budget.maxCost <= 0) {
    throw new Error('OpenRouter inference requires a positive remaining cost budget.');
  }
  // Setting the same $/M ceiling for prompt and completion bounds either token
  // split by maxTotalTokens. Floor rather than round so floating-point display
  // can never loosen the requested ceiling.
  const rawPerMillion = (budget.maxCost * 1_000_000) / budget.maxTotalTokens;
  const perMillion = Math.floor(rawPerMillion * 1_000_000_000) / 1_000_000_000;
  if (!Number.isFinite(perMillion) || perMillion <= 0) {
    throw new Error('OpenRouter cost budget is too small to express as a provider max_price.');
  }
  return { prompt: perMillion, completion: perMillion, request: 0 as const };
}

function scopedValue(
  environment: NodeJS.ProcessEnv,
  base: string,
  request: BoundInferenceRequest,
) {
  const role = request.role.toUpperCase();
  const purpose = request.purpose.toUpperCase();
  return environment[`${base}_${role}_${purpose}`]?.trim()
    || environment[`${base}_${purpose}`]?.trim()
    || environment[base]?.trim();
}

/** Per-role/per-purpose limits keep short decisions fast while preserving builder capacity. */
export function resolveOpenRouterRequestPolicy(
  request: BoundInferenceRequest,
  environment: NodeJS.ProcessEnv = process.env,
): OpenRouterRequestPolicy {
  const roleDefault = openRouterRoleDefaults[request.role];
  const reviewReasoningTokens = request.model.startsWith('openai/gpt-5') ? 256 : 0;
  const purposeDefault = request.purpose === 'quality_review'
    ? { maxTokens: 2_048, retryMaxTokens: 4_096, reasoningTokens: reviewReasoningTokens, timeoutMs: 120_000 }
    : request.purpose === 'plan'
      ? { maxTokens: 3_072, retryMaxTokens: 4_096, reasoningTokens: 256, timeoutMs: 120_000 }
      : request.purpose === 'plan_repair'
        ? { maxTokens: 4_096, retryMaxTokens: 8_192, reasoningTokens: 256, timeoutMs: 120_000 }
      : request.purpose === 'progress_assessment' || request.purpose === 'completion_assessment'
        ? { maxTokens: 1_536, retryMaxTokens: 3_072, reasoningTokens: 256, timeoutMs: 120_000 }
        : request.purpose === 'generate' || request.purpose === 'revise'
          ? { ...roleDefault, retryMaxTokens: Math.max(roleDefault.maxTokens, 8_192) }
          : { ...roleDefault, retryMaxTokens: roleDefault.maxTokens };
  const configuredMaxTokens = positiveInteger(
    scopedValue(environment, 'OPENROUTER_MAX_TOKENS', request),
    purposeDefault.maxTokens,
    131_072,
    'OpenRouter max tokens',
  );
  const maxTokens = boundedCompletionTokens(request, configuredMaxTokens);
  const configuredRetryMaxTokens = positiveInteger(
    scopedValue(environment, 'OPENROUTER_RETRY_MAX_TOKENS', request),
    purposeDefault.retryMaxTokens,
    131_072,
    'OpenRouter retry max tokens',
  );
  const retryMaxTokens = boundedCompletionTokens(
    request,
    Math.max(configuredMaxTokens, configuredRetryMaxTokens),
  );
  const configuredReasoningTokens = nonNegativeInteger(
    scopedValue(environment, 'OPENROUTER_REASONING_MAX_TOKENS', request),
    purposeDefault.reasoningTokens,
    Math.max(0, configuredMaxTokens - 512),
    'OpenRouter reasoning max tokens',
  );
  const reasoningTokens = Math.min(configuredReasoningTokens, Math.max(0, maxTokens - 1));
  const configuredTimeoutMs = positiveInteger(
    scopedValue(environment, 'OPENROUTER_TIMEOUT_MS', request)
      || environment.MODEL_TIMEOUT_MS?.trim(),
    purposeDefault.timeoutMs,
    1_800_000,
    'OpenRouter timeout',
  );
  const timeoutMs = boundedDeadlineMs(request.inferenceBudget, configuredTimeoutMs);
  const configuredIdleTimeoutMs = positiveInteger(
    scopedValue(environment, 'OPENROUTER_IDLE_TIMEOUT_MS', request),
    purposeDefault.timeoutMs,
    1_800_000,
    'OpenRouter idle timeout',
  );
  const idleTimeoutMs = Math.min(configuredIdleTimeoutMs, timeoutMs);
  const configuredAttempts = positiveInteger(
    scopedValue(environment, 'OPENROUTER_HTTP_ATTEMPTS', request),
    2,
    5,
    'OpenRouter HTTP attempts',
  );
  // A bounded call may make one explicitly accounted retry. More attempts
  // multiply prompt spend and make the remaining envelope too unpredictable.
  const attempts = request.inferenceBudget ? Math.min(configuredAttempts, 2) : configuredAttempts;
  const configuredSort = scopedValue(environment, 'OPENROUTER_PROVIDER_SORT', request);
  const prefersLatency = request.purpose === 'quality_review'
    || request.purpose === 'plan'
    || request.purpose === 'plan_repair'
    || request.purpose === 'progress_assessment'
    || request.purpose === 'completion_assessment'
    || request.role === 'manager'
    || request.role === 'product'
    || request.role === 'reviewer'
    || request.model.startsWith('openai/gpt-5');
  const sort = configuredSort || (prefersLatency ? 'latency' : 'throughput');
  if (sort !== 'latency' && sort !== 'throughput') {
    throw new Error('OpenRouter provider sort must be latency or throughput.');
  }
  return {
    maxTokens,
    retryMaxTokens,
    reasoningTokens,
    timeoutMs,
    idleTimeoutMs,
    attempts,
    provider: {
      sort,
      allow_fallbacks: !request.inferenceBudget,
      // GPT-5, Builder, and review artifacts are prompt-validated locally, so
      // availability takes priority over requiring every optional parameter
      // (notably response_format and reasoning controls) natively.
      require_parameters: !request.model.startsWith('openai/gpt-5')
        && request.role !== 'manager'
        && request.role !== 'builder'
        && request.role !== 'test'
        && request.role !== 'reviewer'
        && request.purpose !== 'quality_review',
      ...(sort === 'latency'
        ? { preferred_max_latency: { p90: 5 } }
        : { preferred_min_throughput: { p50: 30 } }),
      ...(request.inferenceBudget
        ? { max_price: boundedOpenRouterMaxPrice(request.inferenceBudget) }
        : {}),
    },
  };
}

/**
 * Node's built-in fetch (undici) defaults headersTimeout/bodyTimeout to 300s.
 * With stream:false Ollama holds response headers until generation finishes, so
 * long local model runs fail around five minutes even when AbortSignal allows more.
 * Use node:http so the only deadline is MODEL_TIMEOUT_MS / OLLAMA_TIMEOUT_MS.
 */
async function postJson(
  url: URL,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string>,
  timeoutLabel: string,
): Promise<{ status: number; text: string; headers: IncomingMessage['headers'] }> {
  const payload = Buffer.from(JSON.stringify(body));
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': payload.byteLength,
      ...headers,
    },
  };

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    let req: ReturnType<typeof transport>;
    let activitySignal: AbortSignal | undefined;
    try {
      activitySignal = cancellationSignal();
    } catch {
      // Direct unit calls do not have an Activity context.
    }
    const cleanup = () => {
      clearTimeout(timer);
      activitySignal?.removeEventListener('abort', cancelRequest);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const cancelRequest = () => req?.destroy(new Error(`${timeoutLabel} was cancelled.`));
    req = transport(options, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let received = 0;
      // Provider output still crosses an Activity boundary before the final
      // artifact is persisted. Keep it well below Temporal's 2 MiB ceiling;
      // persisted artifacts move between roles by content address instead.
      const maximumBytes = positiveInteger(process.env.MODEL_MAX_RESPONSE_BYTES, 1_000_000, 10_000_000, 'MODEL_MAX_RESPONSE_BYTES');
      res.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > maximumBytes) {
          res.destroy(new Error(`${timeoutLabel} response exceeded ${maximumBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        finish(() => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      });
      res.on('error', (error) => {
        finish(() => reject(error));
      });
    });

    timer = setTimeout(() => {
      req.destroy(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    req.on('error', (error) => {
      finish(() => reject(error));
    });
    activitySignal?.addEventListener('abort', cancelRequest, { once: true });
    if (activitySignal?.aborted) cancelRequest();
    req.write(payload);
    req.end();
  });
}

function assertBoundedInferenceResult(
  request: BoundInferenceRequest,
  result: OllamaInferenceResult,
): OllamaInferenceResult {
  const budget = request.inferenceBudget;
  if (!budget) return result;
  assertModelInferenceBudget(budget);
  if (remainingModelInferenceDeadlineMs(budget, Date.now()) <= 0) {
    throw new Error('Inference provider completed after its absolute deadline.');
  }
  const usage = result.usage;
  const totalTokens = usage?.totalTokens
    ?? (usage?.promptTokens !== undefined && usage.completionTokens !== undefined
      ? usage.promptTokens + usage.completionTokens
      : undefined);
  if (!Number.isSafeInteger(totalTokens) || totalTokens! < 0) {
    throw new Error('Bounded inference requires provider token usage accounting.');
  }
  if (totalTokens! > budget.maxTotalTokens) {
    throw new Error(`Inference used ${totalTokens} tokens, exceeding its ${budget.maxTotalTokens}-token envelope.`);
  }
  const cost = request.provider === 'ollama' ? usage?.cost ?? 0 : usage?.cost;
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) {
    throw new Error('Bounded remote inference requires provider cost usage accounting.');
  }
  if (cost > budget.maxCost) {
    throw new Error(`Inference cost ${cost} exceeded its ${budget.maxCost} cost envelope.`);
  }
  return result;
}

async function inferWithOllama(request: BoundInferenceRequest): Promise<OllamaInferenceResult> {
  if (request.provider !== 'ollama') throw new Error('Ollama Activity rejected a non-Ollama request.');
  request = await hydrateAddressedArtifacts(request);
  const model = request.model;
  const host = process.env.OLLAMA_HOST ?? 'http://host.docker.internal:11434';
  const timeoutMs = boundedDeadlineMs(request.inferenceBudget, inferenceTimeoutMs('ollama'));
  const maximumCompletionTokens = boundedCompletionTokens(request, 131_072);
  const response = await postJson(
    new URL('/api/chat', host),
    {
      model,
      stream: false,
      format: 'json',
      options: {
        temperature: request.temperature,
        ...(request.inferenceBudget ? { num_predict: maximumCompletionTokens } : {}),
      },
      messages: request.messages,
    },
    timeoutMs,
    {},
    'Ollama request',
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Ollama returned ${response.status}. Ensure model ${model} is available.`);
  }
  const payload = JSON.parse(response.text) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const content = payload.message?.content;
  if (!content) throw new Error(`Ollama model ${model} returned no content for ${request.purpose}.`);
  const promptTokens = Number.isInteger(payload.prompt_eval_count) && payload.prompt_eval_count! >= 0
    ? payload.prompt_eval_count : undefined;
  const completionTokens = Number.isInteger(payload.eval_count) && payload.eval_count! >= 0
    ? payload.eval_count : undefined;
  const usage = promptTokens !== undefined || completionTokens !== undefined
    ? {
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(promptTokens !== undefined && completionTokens !== undefined
          ? { totalTokens: promptTokens + completionTokens }
          : {}),
      }
    : undefined;
  return assertBoundedInferenceResult(
    request,
    { provider: 'ollama', model, content, ...(usage ? { usage } : {}) },
  );
}

function openRouterUrl() {
  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const url = new URL(`${baseUrl}/chat/completions`);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('OPENROUTER_BASE_URL must use HTTPS (HTTP is allowed only for loopback tests).');
  }
  return url;
}

function assertOpenRouterPolicy(model: string) {
  if (process.env.OPENROUTER_ALLOW_REMOTE_DATA?.trim().toLowerCase() !== 'true') {
    throw new Error('OpenRouter is disabled until OPENROUTER_ALLOW_REMOTE_DATA=true acknowledges remote prompt processing.');
  }
  const allowlist = process.env.OPENROUTER_ALLOWED_MODELS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  if (allowlist.length > 0 && !allowlist.includes(model)) {
    throw new Error(`OpenRouter model ${model} is not in OPENROUTER_ALLOWED_MODELS.`);
  }
}

function retryDelayMs(headers: IncomingMessage['headers'], attempt: number) {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(30_000, retryAfter * 1_000);
  return Math.min(5_000, 250 * (2 ** (attempt - 1)));
}

function openRouterReasoning(reasoningTokens: number) {
  return reasoningTokens === 0
    ? { enabled: false }
    : { max_tokens: reasoningTokens, exclude: true };
}

interface OpenRouterPayload {
  id?: string;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  choices?: Array<{
    finish_reason?: string;
    native_finish_reason?: string;
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
}

interface OpenRouterStreamChunk extends OpenRouterPayload {
  error?: {
    code?: string | number;
    message?: string;
    metadata?: Record<string, unknown>;
  };
  choices?: Array<{
    finish_reason?: string;
    native_finish_reason?: string;
    delta?: { content?: string | Array<{ type?: string; text?: string }> };
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
}

class AmbiguousOpenRouterStreamError extends Error {}
class RetryableOpenRouterStreamError extends Error {}

function openRouterStreamError(error: NonNullable<OpenRouterStreamChunk['error']>) {
  const metadata = error.metadata && Object.keys(error.metadata).length > 0
    ? JSON.stringify(error.metadata).slice(0, 2_000)
    : undefined;
  const details = [
    error.code !== undefined ? `code=${error.code}` : undefined,
    metadata ? `metadata=${metadata}` : undefined,
  ].filter(Boolean).join(', ');
  return `${error.message ?? 'OpenRouter returned a streaming error.'}${details ? ` (${details})` : ''}`;
}

function reportOpenRouterProgress(details: Record<string, unknown>) {
  try {
    heartbeat(details);
  } catch {
    // Direct unit calls have no Temporal Activity context.
  }
}

function streamedContent(chunk: OpenRouterStreamChunk) {
  const content = chunk.choices?.[0]?.delta?.content;
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => part.text ?? '').join('')
      : '';
}

async function postOpenRouterStream(
  url: URL,
  body: unknown,
  policy: OpenRouterRequestPolicy,
  headers: Record<string, string>,
  request: BoundInferenceRequest,
): Promise<{ status: number; text: string; headers: IncomingMessage['headers'] }> {
  const payload = Buffer.from(JSON.stringify(body));
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'content-length': payload.byteLength,
      ...headers,
    },
  };

  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let responseStarted = false;
    let requestCommitted = false;
    let completed = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    let requestHandle: ReturnType<typeof transport> | undefined;
    let activitySignal: AbortSignal | undefined;
    try {
      activitySignal = cancellationSignal();
    } catch {
      // Direct unit calls do not have an Activity context.
    }
    const cancelRequest = () => requestHandle?.destroy(new Error('OpenRouter request was cancelled.'));
    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (progressTimer) clearInterval(progressTimer);
      activitySignal?.removeEventListener('abort', cancelRequest);
      callback();
    };
    const fail = (error: unknown) => finish(() => reject(
      error instanceof RetryableOpenRouterStreamError
        ? error
        : responseStarted || requestCommitted
        ? new AmbiguousOpenRouterStreamError(error instanceof Error ? error.message : String(error))
        : error,
    ));
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        requestHandle?.destroy(new Error(`OpenRouter stream was idle for ${policy.idleTimeoutMs}ms`));
      }, policy.idleTimeoutMs);
      idleTimer.unref?.();
    };
    const totalTimer = setTimeout(() => {
      requestHandle?.destroy(new Error(`OpenRouter request timed out after ${policy.timeoutMs}ms`));
    }, policy.timeoutMs);
    totalTimer.unref?.();
    progressTimer = setInterval(() => {
      reportOpenRouterProgress({
        stage: responseStarted ? 'streaming' : 'waiting_for_provider',
        role: request.role,
        purpose: request.purpose,
        elapsedMs: Date.now() - startedAt,
      });
    }, 10_000);
    progressTimer.unref?.();
    reportOpenRouterProgress({ stage: 'request_started', role: request.role, purpose: request.purpose, elapsedMs: 0 });

    requestHandle = transport(options, (res: IncomingMessage) => {
      responseStarted = true;
      resetIdleTimer();
      const chunks: Buffer[] = [];
      let received = 0;
      let eventBuffer = '';
      const decoder = new StringDecoder('utf8');
      let content = '';
      let id: string | undefined;
      let model: string | undefined;
      let usage: OpenRouterPayload['usage'];
      let finishReason: string | undefined;
      let nativeFinishReason: string | undefined;
      const maximumBytes = positiveInteger(process.env.MODEL_MAX_RESPONSE_BYTES, 2_000_000, 10_000_000, 'MODEL_MAX_RESPONSE_BYTES');
      const isEventStream = String(res.headers['content-type'] ?? '').includes('text/event-stream');
      // SSE has substantial framing and provider metadata overhead (for some
      // reasoning models, signed reasoning details can dwarf the final text).
      // Keep the compact, parsed result bounded by MODEL_MAX_RESPONSE_BYTES,
      // while giving the transient wire stream a separate finite ceiling.
      const maximumStreamBytes = positiveInteger(
        process.env.OPENROUTER_MAX_STREAM_BYTES,
        10_000_000,
        50_000_000,
        'OPENROUTER_MAX_STREAM_BYTES',
      );
      const maximumWireBytes = isEventStream ? maximumStreamBytes : maximumBytes;
      const processEvent = (event: string) => {
        const data = event.split(/\r?\n/u)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') return;
        let parsed: OpenRouterStreamChunk;
        try {
          parsed = JSON.parse(data) as OpenRouterStreamChunk;
        } catch (error) {
          throw new Error('OpenRouter returned a malformed streaming event.', { cause: error });
        }
        if (parsed.error) {
          const message = openRouterStreamError(parsed.error);
          if (content.length === 0) throw new RetryableOpenRouterStreamError(message);
          throw new Error(message);
        }
        id = parsed.id ?? id;
        model = parsed.model ?? model;
        usage = parsed.usage ?? usage;
        const choice = parsed.choices?.[0];
        finishReason = choice?.finish_reason ?? finishReason;
        nativeFinishReason = choice?.native_finish_reason ?? nativeFinishReason;
        content += streamedContent(parsed);
        if (Buffer.byteLength(content, 'utf8') > maximumBytes) {
          throw new Error(`OpenRouter content exceeded ${maximumBytes} bytes.`);
        }
        reportOpenRouterProgress({
          stage: 'streaming',
          role: request.role,
          purpose: request.purpose,
          elapsedMs: Date.now() - startedAt,
          receivedBytes: received,
          contentCharacters: content.length,
        });
      };

      res.on('data', (chunk: Buffer) => {
        resetIdleTimer();
        received += chunk.byteLength;
        if (received > maximumWireBytes) {
          res.destroy(new Error(`OpenRouter response exceeded ${maximumWireBytes} wire bytes.`));
          return;
        }
        // Streaming responses are parsed incrementally; retaining their raw
        // provider metadata would multiply memory use without affecting the
        // compact result returned to the workflow.
        if (!isEventStream) chunks.push(chunk);
        if (!isEventStream) return;
        eventBuffer += decoder.write(chunk);
        const events = eventBuffer.split(/\r?\n\r?\n/u);
        eventBuffer = events.pop() ?? '';
        try {
          for (const event of events) processEvent(event);
        } catch (error) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
      res.on('end', () => {
        try {
          if (isEventStream) eventBuffer += decoder.end();
          if (isEventStream && eventBuffer.trim()) processEvent(eventBuffer);
        } catch (error) {
          fail(error);
          return;
        }
        const text = isEventStream
          ? JSON.stringify({
            id,
            model,
            usage,
            choices: [{
              finish_reason: finishReason,
              native_finish_reason: nativeFinishReason,
              message: { content },
            }],
          } satisfies OpenRouterPayload)
          : Buffer.concat(chunks).toString('utf8');
        reportOpenRouterProgress({
          stage: 'completed',
          role: request.role,
          purpose: request.purpose,
          elapsedMs: Date.now() - startedAt,
          receivedBytes: received,
          contentCharacters: content.length,
        });
        finish(() => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      });
      res.on('error', fail);
    });
    requestHandle.on('error', fail);
    requestHandle.on('finish', () => { requestCommitted = true; });
    activitySignal?.addEventListener('abort', cancelRequest, { once: true });
    if (activitySignal?.aborted) cancelRequest();
    requestHandle.write(payload);
    requestHandle.end();
  });
}

function openRouterContent(payload: OpenRouterPayload) {
  const message = payload.choices?.[0]?.message?.content;
  return typeof message === 'string'
    ? message
    : Array.isArray(message)
      ? message.map((part) => part.text ?? '').join('')
      : undefined;
}

function emptyOpenRouterResponseError(
  request: BoundInferenceRequest,
  payload: OpenRouterPayload,
  attempts: number,
) {
  const choice = payload.choices?.[0];
  const metadata = [
    payload.id ? `requestId=${payload.id}` : undefined,
    choice?.finish_reason ? `finishReason=${choice.finish_reason}` : undefined,
    choice?.native_finish_reason ? `nativeFinishReason=${choice.native_finish_reason}` : undefined,
    payload.usage?.completion_tokens !== undefined ? `completionTokens=${payload.usage.completion_tokens}` : undefined,
    payload.usage?.total_tokens !== undefined ? `totalTokens=${payload.usage.total_tokens}` : undefined,
  ].filter(Boolean).join(', ');
  return new Error(
    `OpenRouter model ${request.model} returned no content for ${request.purpose} after ${attempts} attempts${metadata ? ` (${metadata})` : ''}.`,
  );
}

async function inferWithOpenRouter(request: BoundInferenceRequest): Promise<OllamaInferenceResult> {
  if (request.provider !== 'openrouter') throw new Error('OpenRouter Activity rejected a non-OpenRouter request.');
  request = await hydrateAddressedArtifacts(request);
  const model = request.model;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required when MODEL_PROVIDER=openrouter.');
  }
  assertOpenRouterPolicy(model);
  const url = openRouterUrl();
  const policy = resolveOpenRouterRequestPolicy(request);
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
  };
  const referer = process.env.OPENROUTER_HTTP_REFERER?.trim();
  const title = process.env.OPENROUTER_APP_TITLE?.trim();
  if (referer) headers['http-referer'] = referer;
  if (title) headers['x-title'] = title;

  let lastError: unknown;
  const cumulativeUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
  let escalateOutputLimit = false;
  const recordBudgetedUsage = (usage: OpenRouterPayload['usage']) => {
    if (!request.inferenceBudget) return;
    if (!usage
      || usage.prompt_tokens === undefined
      || usage.completion_tokens === undefined
      || usage.cost === undefined) {
      throw new Error('OpenRouter retry usage was unavailable; the remaining inference budget cannot be enforced.');
    }
    const totalTokens = usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens;
    cumulativeUsage.promptTokens += usage.prompt_tokens;
    cumulativeUsage.completionTokens += usage.completion_tokens;
    cumulativeUsage.totalTokens += totalTokens;
    cumulativeUsage.cost += usage.cost;
  };
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    let attemptPolicy = policy;
    if (attempt > 1) {
      const remainingBudget = request.inferenceBudget ? {
        ...request.inferenceBudget,
        maxTotalTokens: request.inferenceBudget.maxTotalTokens - cumulativeUsage.totalTokens,
        maxCost: request.inferenceBudget.maxCost - cumulativeUsage.cost,
      } : undefined;
      const retryRequest = remainingBudget ? { ...request, inferenceBudget: remainingBudget } : request;
      const retryMaxTokens = boundedCompletionTokens(
        retryRequest,
        escalateOutputLimit ? policy.retryMaxTokens : policy.maxTokens,
      );
      const retryTimeoutMs = boundedDeadlineMs(remainingBudget, policy.timeoutMs);
      attemptPolicy = {
        ...policy,
        maxTokens: retryMaxTokens,
        reasoningTokens: Math.min(policy.reasoningTokens, Math.max(0, retryMaxTokens - 1)),
        timeoutMs: retryTimeoutMs,
        idleTimeoutMs: Math.min(policy.idleTimeoutMs, retryTimeoutMs),
        provider: {
          ...policy.provider,
          ...(remainingBudget ? { max_price: boundedOpenRouterMaxPrice(remainingBudget) } : {}),
        },
      };
    }
    const reasoning = openRouterReasoning(attemptPolicy.reasoningTokens);
    let response: Awaited<ReturnType<typeof postJson>>;
    try {
      response = await postOpenRouterStream(url, {
        model,
        temperature: request.temperature,
        max_tokens: attemptPolicy.maxTokens,
        reasoning,
        provider: attemptPolicy.provider,
        response_format: { type: 'json_object' },
        stream: true,
        stream_options: { include_usage: true },
        messages: request.messages,
      }, attemptPolicy, headers, request);
    } catch (error) {
      lastError = error;
      if (error instanceof AmbiguousOpenRouterStreamError || attempt === policy.attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 250 * (2 ** (attempt - 1)))));
      continue;
    }

    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < policy.attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response.headers, attempt)));
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = response.text.slice(0, 500);
      throw new Error(`OpenRouter returned ${response.status} for model ${model}.${detail ? ` ${detail}` : ''}`);
    }

    let payload: OpenRouterPayload;
    try {
      payload = JSON.parse(response.text) as OpenRouterPayload;
    } catch (error) {
      lastError = new Error(`OpenRouter returned malformed JSON for ${request.purpose}.`, { cause: error });
      // A successful provider response without parseable usage cannot be
      // charged against a bounded retry envelope safely.
      if (request.inferenceBudget || attempt === policy.attempts) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response.headers, attempt)));
      continue;
    }

    recordBudgetedUsage(payload.usage);

    const content = openRouterContent(payload);
    if (!content?.trim()) {
      lastError = emptyOpenRouterResponseError(request, payload, attempt);
      if (attempt === policy.attempts) throw emptyOpenRouterResponseError(request, payload, policy.attempts);
      const choice = payload.choices?.[0];
      escalateOutputLimit = choice?.finish_reason === 'length'
        || choice?.native_finish_reason === 'max_tokens';
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response.headers, attempt)));
      continue;
    }

    const usage: ModelTokenUsage | undefined = request.inferenceBudget
      ? { ...cumulativeUsage }
      : payload.usage ? {
        promptTokens: payload.usage.prompt_tokens,
        completionTokens: payload.usage.completion_tokens,
        totalTokens: payload.usage.total_tokens,
        cost: payload.usage.cost,
      } : undefined;
    return assertBoundedInferenceResult(request, {
      provider: 'openrouter',
      model: payload.model ?? model,
      content,
      requestId: payload.id,
      usage,
    });
  }
  throw lastError instanceof Error ? lastError : new Error('OpenRouter request failed.');
}

/** Readable by brain workflows (via the inference queue) so routing stays deterministic. */
export async function resolveInferencePolicy(role?: AgentExecutionInput['role']): Promise<InferenceRoutingPolicy> {
  // The fallback is only for a pre-migration Activity invocation whose history has no role argument.
  return resolveInferenceRoutingPolicy(role ?? 'manager', process.env);
}

export async function ollamaProviderInference(request: BoundInferenceRequest): Promise<OllamaInferenceResult> {
  return await inferWithOllama(request);
}

export async function openRouterInference(request: BoundInferenceRequest): Promise<OllamaInferenceResult> {
  return await inferWithOpenRouter(request);
}

/**
 * The only function in this package allowed to perform provider HTTP inference.
 * It is registered on the inference task queue. Ollama stays single-flight via
 * the FIFO lane + worker concurrency; OpenRouter may run many in parallel.
 */
export async function ollamaInference(request: OllamaInferenceRequest): Promise<OllamaInferenceResult> {
  const policy = resolveInferenceRoutingPolicy(request.role, process.env);
  const bound = { ...request, provider: policy.provider, model: policy.model };
  if (policy.provider === 'openrouter') return await inferWithOpenRouter(bound);
  return await inferWithOllama(bound);
}

function workflowIdPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'unknown';
}

/**
 * Compatibility Activity for existing project Workflow histories that already
 * scheduled `runAgent`. It performs no inference itself; it idempotently bridges
 * the old Activity call into the role-specific modelInteractionWorkflow queue.
 */
export async function runAgent(input: AgentExecutionInput): Promise<AgentArtifactDraft> {
  if (!modelWorkflowClient) throw new Error('The legacy model Activity bridge has no Temporal Client.');
  const info = activityInfo();
  const workflowId = [
    'legacy-model-interaction',
    workflowIdPart(input.project.id),
    workflowIdPart(input.iteration.id),
    input.role,
    workflowIdPart(info.workflowExecution?.runId ?? 'manual'),
    workflowIdPart(info.activityId),
  ].join('/');

  try {
    return await modelWorkflowClient.workflow.execute('modelInteractionWorkflow', {
      workflowId,
      taskQueue: agentModelTaskQueue(input.role),
      args: [input],
    }) as AgentArtifactDraft;
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    return await modelWorkflowClient.workflow.getHandle(workflowId).result() as AgentArtifactDraft;
  }
}
