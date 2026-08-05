import type { AgentExecutionInput, AgentRole } from '@orchestra/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentModelActionRequest,
  buildGenerationRequest,
  buildQualityReviewRequest,
  completeAgentModelAction,
  executeModelInteraction,
  finalizeAgentModelCandidate,
  formatInferenceFailure,
  parseAgentArtifact,
  parseModelQualityReview,
  remainingModelInferenceDeadlineMs,
  type OllamaInferenceRequest,
  type OllamaInferenceResult,
} from './model-protocol.js';

const previewDockerfile = [
  'FROM node:26-alpine',
  'ENV PORT=8080',
  'EXPOSE 8080',
  'HEALTHCHECK CMD wget -q --spider http://127.0.0.1:8080/health || exit 1',
  'CMD ["node", "server.js"]',
].join('\n');

function input(role: AgentRole, artifactType = `${role}-artifact`): AgentExecutionInput {
  const now = '2026-08-03T12:00:00.000Z';
  const projectId = '00000000-0000-4000-8000-000000000001';
  return {
    role,
    artifactType,
    context: 'Approved project context.',
    project: {
      id: projectId,
      name: 'Orchestra',
      intent: 'Turn a human intention into reviewed, traceable software.',
      audience: 'Non-technical founders',
      success: 'A reviewed increment reaches its stated outcome.',
      constraints: [],
      status: 'defining',
      currentIteration: 1,
      previewUrl: null,
      repositoryUrl: null,
      repositoryOwner: null,
      repositoryName: null,
      createdAt: now,
      updatedAt: now,
    },
    iteration: {
      id: '00000000-0000-4000-8000-000000000002',
      projectId,
      number: 1,
      objective: 'Define and implement the first increment.',
      status: 'active',
      startedAt: now,
      completedAt: null,
      issueNumber: null,
      branchName: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
    },
  };
}

function result(content: unknown, model = 'test-model'): OllamaInferenceResult {
  return { model, content: typeof content === 'string' ? content : JSON.stringify(content) };
}

describe('formatInferenceFailure', () => {
  it('joins Error cause chains so operators see the root Ollama failure', () => {
    const root = new Error('Headers Timeout Error');
    const wrapped = new Error('Child Workflow execution failed', { cause: new Error('Activity task failed', { cause: root }) });
    expect(formatInferenceFailure(wrapped)).toBe(
      'Child Workflow execution failed → Activity task failed → Headers Timeout Error',
    );
  });
});

describe('model interaction protocol', () => {
  it('propagates one-call inference budgets through model actions', () => {
    const inferenceBudget = {
      maxTotalTokens: 12_000,
      maxCost: 0.25,
      deadlineEpochMs: 2_000_000,
    };
    expect(buildAgentModelActionRequest({
      action: 'generate_candidate',
      input: input('requirements'),
      inferenceBudget,
    })).toMatchObject({ purpose: 'generate', inferenceBudget });
    expect(remainingModelInferenceDeadlineMs(inferenceBudget, 1_999_250)).toBe(750);
  });

  it('builds exactly one inference request for each one-shot model action', () => {
    const artifactInput = input('requirements', 'requirements-baseline');
    const review = { status: 'revise', rationale: 'Needs evidence.', findings: ['Add evidence.'] } as const;

    expect(buildAgentModelActionRequest({
      action: 'generate_candidate',
      input: artifactInput,
    })?.purpose).toBe('generate');
    expect(buildAgentModelActionRequest({
      action: 'quality_review',
      input: artifactInput,
      candidate: '{"content":"# Requirements"}',
      round: 2,
    })).toMatchObject({ purpose: 'quality_review', role: 'reviewer', round: 2 });
    expect(buildAgentModelActionRequest({
      action: 'revise_candidate',
      input: artifactInput,
      candidate: '{"content":"# Requirements"}',
      review,
      round: 3,
    })).toMatchObject({ purpose: 'revise', role: 'requirements', round: 3 });
    expect(buildAgentModelActionRequest({
      action: 'finalize_candidate',
      input: artifactInput,
      candidate: result({ content: '# Requirements' }),
      modelInvocations: [],
    })).toBeUndefined();
  });

  it('parses one-shot review results and finalizes a recorded candidate without inference', () => {
    const artifactInput = input('product', 'product-scope');
    const reviewRequest = buildQualityReviewRequest(
      artifactInput,
      '{"content":"# Product scope"}',
      1,
    );
    const reviewed = completeAgentModelAction(
      'quality_review',
      reviewRequest,
      {
        ...result({ status: 'pass', rationale: 'Complete.', findings: [] }, 'review-model'),
        provider: 'openrouter',
        requestId: 'review-1',
      },
    );
    expect(reviewed).toMatchObject({
      action: 'quality_review',
      review: { status: 'pass', rationale: 'Complete.', findings: [] },
      invocation: {
        provider: 'openrouter',
        model: 'review-model',
        purpose: 'quality_review',
        round: 1,
        requestId: 'review-1',
      },
    });

    const candidate = {
      ...result({ content: '# Product scope', questions: [] }, 'product-model'),
      provider: 'openrouter' as const,
      requestId: 'candidate-1',
    };
    const invocation = {
      provider: candidate.provider,
      model: candidate.model,
      purpose: 'generate' as const,
      round: 0,
      requestId: candidate.requestId,
    };
    expect(finalizeAgentModelCandidate({
      action: 'finalize_candidate',
      input: artifactInput,
      candidate,
      modelInvocations: [invocation],
    })).toMatchObject({
      type: 'product-scope',
      content: '# Product scope',
      model: 'product-model',
      modelProvider: 'openrouter',
      modelInvocations: [invocation],
    });
  });

  it('pins the Builder generation and review prompts to the shared preview runtime', () => {
    const builderInput = input('builder', 'build-submission');
    const generation = buildGenerationRequest(builderInput).messages[0]?.content;
    const review = buildQualityReviewRequest(builderInput, '{"content":"candidate"}', 0).messages[0]?.content;

    for (const prompt of [generation, review]) {
      expect(prompt).toContain('root Dockerfile');
      expect(prompt).toContain('0.0.0.0:8080');
      expect(prompt).toContain('GET /health');
      expect(prompt).toContain('no secrets or companion services');
      expect(prompt).toContain('Docker HEALTHCHECK');
      expect(prompt).toContain('lockfile');
    }
    expect(generation).toContain('before accepting your handoff');
    expect(generation).toContain('install, compile, test, startup, or health failure');
    expect(buildGenerationRequest(builderInput).messages[1]?.content).toContain('Do not return package-lock.json');
    expect(review).toContain('Reject every generated dependency lockfile');
  });

  it('teaches quality review the bounded root-level human-question contract', () => {
    const request = buildQualityReviewRequest(input('requirements'), '{"content":"# Requirements","questions":[]}', 0);
    const review = request.messages[0]?.content;

    expect(review).toContain('root-level JSON sibling of content');
    expect(review).toContain('Allow at most 3 questions');
    expect(review).toContain('exactly one decision per question');
    expect(review).toContain('do not require it to be false');
    expect(review).toContain('must not exceed 1600 words');
    expect(request.messages[1]?.content).toContain('<APPROVED_CONTEXT_AND_HUMAN_DIRECTION>');
    expect(request.messages[1]?.content).toContain('Approved project context.');
  });

  it('forbids re-asking durable human decisions during generation', () => {
    const prompt = buildGenerationRequest(input('architecture')).messages[0]?.content;

    expect(prompt).toContain('Human direction in the approved context is authoritative');
    expect(prompt).toContain('Never ask a question whose decisionKey or meaning is already answered');
  });

  it('keeps Data artifacts within the structured-response output envelope', () => {
    const generation = buildGenerationRequest(input('data')).messages[0]?.content;
    const review = buildQualityReviewRequest(input('data'), '{"content":"# Data model","questions":[]}', 0)
      .messages[0]?.content;

    expect(generation).toContain('at most 1000 words');
    expect(review).toContain('must not exceed 1000 words');
  });

  it('accepts one complete fenced JSON object without accepting surrounding commentary', () => {
    expect(parseModelQualityReview('```json\n{"status":"pass","rationale":"Complete.","findings":[]}\n```'))
      .toEqual({ status: 'pass', rationale: 'Complete.', findings: [] });
    expect(parseModelQualityReview('Here is the review:\n```json\n{"status":"pass","rationale":"Complete.","findings":[]}\n```'))
      .toMatchObject({ status: 'revise', rationale: 'The model quality review was malformed.' });

    expect(parseAgentArtifact(
      input('product', 'product-scope'),
      result('```json\n{"content":"# Product scope","questions":[]}\n```'),
    ).content).toBe('# Product scope');
  });

  it('generates and independently reviews a structured human question', async () => {
    const infer = vi.fn(async (request: OllamaInferenceRequest) => {
      if (request.purpose === 'generate') return result({
        content: '# Product scope',
        questions: [{
          question: 'Which audience should the first increment prioritize?',
          context: 'Supporting both audiences doubles onboarding scope.',
          options: [
            { value: 'organizers', label: 'Organizers', description: 'Prioritize setup.' },
            { value: 'residents', label: 'Residents', description: 'Prioritize joining.' },
          ],
          allowCustomAnswer: true,
          allowAgentDecide: false,
        }],
      });
      return result({ status: 'pass', rationale: 'Complete and traceable.', findings: [] }, 'review-model');
    });

    const artifact = await executeModelInteraction(input('product', 'product-scope'), infer);

    expect(infer.mock.calls.map(([request]) => [request.purpose, request.role])).toEqual([
      ['generate', 'product'],
      ['quality_review', 'reviewer'],
    ]);
    expect(artifact.questions?.[0]).toMatchObject({
      question: 'Which audience should the first increment prioritize?',
      allowAgentDecide: false,
    });
  });

  it('revises a complete Builder artifact and preserves source files', async () => {
    const outputs = [
      result({ content: '# Build submission\n\nMissing tests.', files: [{ path: 'src/main.ts', content: 'export const ready = true;' }] }),
      result({ status: 'revise', rationale: 'Tests are missing.', findings: ['Add a focused unit test.'] }),
      result({ content: '# Build submission\n\nImplementation and tests included.', files: [
        { path: 'Dockerfile', content: previewDockerfile },
        { path: 'src/main.ts', content: 'export const ready = true;' },
        { path: 'src/main.test.ts', content: 'expect(ready).toBe(true);' },
      ] }),
      result({ status: 'pass', rationale: 'Complete.', findings: [] }),
    ];
    const infer = vi.fn(async (_request: OllamaInferenceRequest) => outputs.shift()!);

    const artifact = await executeModelInteraction(input('builder', 'build-submission'), infer);

    expect(infer).toHaveBeenCalledTimes(4);
    expect(artifact.attachments?.map((attachment) => attachment.name)).toEqual([
      'Dockerfile',
      'src/main.ts',
      'src/main.test.ts',
    ]);
  });

  it('turns a false Builder review pass into a Dockerfile repair', async () => {
    const outputs = [
      result({ content: '# Build', files: [{ path: 'server.js', content: 'serve();' }] }),
      result({ status: 'pass', rationale: 'Looks complete.', findings: [] }),
      result({ content: '# Build', files: [
        { path: 'Dockerfile', content: previewDockerfile },
        { path: 'server.js', content: 'serve();' },
      ] }),
      result({ status: 'pass', rationale: 'Runtime contract is present.', findings: [] }),
    ];
    const infer = vi.fn(async (_request: OllamaInferenceRequest) => outputs.shift()!);

    const artifact = await executeModelInteraction(input('builder', 'build-submission'), infer);

    expect(infer).toHaveBeenCalledTimes(4);
    expect(artifact.attachments?.map((attachment) => attachment.name)).toContain('Dockerfile');
    const revisionRequest = infer.mock.calls[2]?.[0] as OllamaInferenceRequest;
    expect(revisionRequest.messages[1]?.content).toContain('exactly one non-empty root Dockerfile');
    expect(revisionRequest.messages[0]?.content).toContain("at or below the prior candidate's length");
  });

  it('bounds repeated revisions at two rounds', async () => {
    let revision = 0;
    const purposes: string[] = [];
    const infer = vi.fn(async (request: OllamaInferenceRequest) => {
      purposes.push(request.purpose);
      if (request.purpose === 'quality_review') {
        return result({ status: 'revise', rationale: 'More work.', findings: ['Tighten the evidence.'] });
      }
      if (request.purpose === 'revise') revision += 1;
      return result({ content: `# Candidate ${revision}` });
    });

    const artifact = await executeModelInteraction(input('requirements'), infer);

    expect(purposes).toEqual(['generate', 'quality_review', 'revise', 'quality_review', 'revise', 'quality_review']);
    expect(artifact.content).toBe('# Candidate 2');
  });

  it('rejects truncated JSON and incomplete questions instead of committing partial artifacts', () => {
    expect(() => parseAgentArtifact(
      input('manager', 'project-charter'),
      result('{"content":"# Charter","questions":[{"question":"Choose?","options":[{"value":"a"'),
    )).toThrow();

    expect(() => parseAgentArtifact(input('manager', 'project-charter'), result({
      content: '# Charter',
      questions: [{
        question: 'Choose a baseline?',
        options: [{ value: 'wcag-2.2-aa' }],
      }],
    }))).toThrow('incomplete or invalid structured question');

    expect(() => parseAgentArtifact(input('requirements'), result({
      content: Array.from({ length: 1_601 }, () => 'word').join(' '),
      questions: [],
    }))).toThrow('reduce it to at most 1600');
  });

  it('turns a false review pass on truncated JSON into a bounded revision', async () => {
    const outputs = [
      result('{"content":"# Charter","questions":['),
      result({ status: 'pass', rationale: 'Looks complete.', findings: [] }),
      result({ content: '# Charter', questions: [] }),
      result({ status: 'pass', rationale: 'Complete structured output.', findings: [] }),
    ];
    const infer = vi.fn(async (_request: OllamaInferenceRequest) => outputs.shift()!);

    const artifact = await executeModelInteraction(input('manager', 'project-charter'), infer);

    expect(artifact.content).toBe('# Charter');
    expect(infer).toHaveBeenCalledTimes(4);
    const revisionRequest = infer.mock.calls[2]?.[0] as OllamaInferenceRequest;
    expect(revisionRequest.messages[1]?.content).toContain('Unexpected end of JSON input');
  });

  it('turns a false Gate review pass into a repair before parsing', async () => {
    const outputs = [
      result({ content: '# Gate decision without a decision' }),
      result({ status: 'pass', rationale: 'Looks plausible.', findings: [] }),
      result({
        content: '# Gate decision',
        gateDecision: { status: 'blocked', rationale: 'Test evidence is absent.', missingEvidence: ['test-evidence'] },
      }),
      result({ status: 'pass', rationale: 'Structured and evidence-bound.', findings: [] }),
    ];
    const infer = vi.fn(async (_request: OllamaInferenceRequest) => outputs.shift()!);

    const artifact = await executeModelInteraction(input('gate', 'gate-decision'), infer);

    expect(infer).toHaveBeenCalledTimes(4);
    expect(artifact.gateDecision).toEqual({
      status: 'blocked',
      rationale: 'Test evidence is absent.',
      missingEvidence: ['test-evidence'],
    });
    const revisionRequest = infer.mock.calls[2]?.[0] as OllamaInferenceRequest;
    expect(revisionRequest.messages[1]?.content).toContain('Gate returned no valid structured gateDecision');
  });

  it('renders UX flow data as escaped SVG and rejects unsafe Builder paths', () => {
    const ux = parseAgentArtifact(input('ux'), result({
      content: '# Journey',
      userFlow: { title: '<script>Journey</script>', steps: ['Open', '<script>alert(1)</script>'] },
    }));
    expect(ux.attachments?.[0]?.content).toContain('&lt;script&gt;');
    expect(ux.attachments?.[0]?.content).not.toContain('<script>');

    const builder = parseAgentArtifact(input('builder'), result({
      content: '# Build',
      files: [
        { path: '../../secret', content: 'no' },
        { path: 'Dockerfile', content: previewDockerfile },
        { path: 'src/safe.ts', content: 'yes' },
      ],
    }));
    expect(builder.attachments?.map((attachment) => attachment.name)).toEqual(['Dockerfile', 'src/safe.ts']);
    expect(() => parseAgentArtifact(input('builder'), result({
      content: '# Build',
      files: [{ path: '/Dockerfile', content: previewDockerfile }],
    }))).toThrow('exactly one non-empty root Dockerfile');
    expect(() => parseAgentArtifact(input('builder'), result({
      content: '# Build',
      files: [{ path: 'Dockerfile', content: 'FROM node:26-alpine\nEXPOSE 8080\nCMD ["node", "server.js"]' }],
    }))).toThrow('real HEALTHCHECK for GET /health');
    expect(() => parseAgentArtifact(input('builder'), result({
      content: '# Build',
      files: [{ path: 'Dockerfile', content: 'FROM node:26-alpine\nEXPOSE 8080\nHEALTHCHECK CMD echo http://127.0.0.1:8080/health' }],
    }))).toThrow('real HEALTHCHECK for GET /health');
    expect(() => parseAgentArtifact(input('builder'), result({
      content: '# Build',
      files: [{ path: 'Dockerfile', content: 'FROM node:26-alpine\nEXPOSE 8080\nHEALTHCHECK CMD wget -q --spider http://localhost:8080/health' }],
    }))).toThrow('real HEALTHCHECK for GET /health');
    expect(() => parseAgentArtifact(input('builder'), result({
      content: '# Build',
      files: [
        { path: 'Dockerfile', content: previewDockerfile },
        { path: 'package-lock.json', content: '{}' },
      ],
    }))).toThrow('must not model-generate dependency lockfile package-lock.json');
  });
});
