import type { AgentArtifactDraft, Project, ProjectArtifact, ProjectIteration } from '@orchestra/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const artifacts = new Map<string, ProjectArtifact>();
  const manifests = new Map<string, string | undefined>();
  const snapshots = new Map<string, AgentArtifactDraft>();
  const questions = new Map<string, string>();
  return {
    artifacts,
    manifests,
    snapshots,
    questions,
    migrate: vi.fn(async () => undefined),
    addArtifact: vi.fn(async (
      projectId: string,
      iterationId: string,
      draft: AgentArtifactDraft,
      _iterationNumber: number | null,
      operationKey?: string,
      options?: { operationManifestHash?: string; operationPayload?: AgentArtifactDraft; stageForRepository?: boolean; sourceRevision?: string },
    ) => {
      const key = operationKey ?? crypto.randomUUID();
      const existing = artifacts.get(key);
      if (existing) {
        if (manifests.get(key) !== options?.operationManifestHash) {
          throw new Error(`Artifact operation ${key} was already used with a different payload.`);
        }
        return existing;
      }
      const artifact: ProjectArtifact = {
        id: artifacts.size === 0
          ? 'a67a2fd5-e829-40dc-a6f5-d15e4758515d'
          : 'b67a2fd5-e829-40dc-a6f5-d15e4758515d',
        projectId,
        iterationId,
        type: draft.type,
        name: draft.name,
        version: artifacts.size + 1,
        content: draft.content,
        mimeType: draft.mimeType,
        status: options?.stageForRepository ? 'draft' : 'ready_for_review',
        producedBy: draft.producedBy,
        model: draft.model,
        modelProvider: draft.modelProvider ?? null,
        modelInvocations: draft.modelInvocations,
        executionTrace: options?.stageForRepository ? undefined : draft.executionTrace,
        repositoryPath: null,
        repositoryUrl: null,
        createdAt: '2026-08-04T12:00:00.000Z',
        reviewedAt: null,
      };
      artifacts.set(key, artifact);
      manifests.set(key, options?.operationManifestHash);
      if (options?.operationPayload) snapshots.set(key, options.operationPayload);
      return artifact;
    }),
    loadArtifactOperationDraft: vi.fn(async (_projectId: string, operationKey: string) => snapshots.get(operationKey)),
    locateArtifact: vi.fn(async (
      artifactId: string,
      repositoryPath: string,
      repositoryUrl: string,
      completion?: { executionTrace?: AgentArtifactDraft['executionTrace'] },
    ) => {
      const entry = [...artifacts.entries()].find(([, artifact]) => artifact.id === artifactId);
      if (!entry) throw new Error(`Missing artifact ${artifactId}.`);
      const located = {
        ...entry[1],
        repositoryPath,
        repositoryUrl,
        status: 'ready_for_review' as const,
        executionTrace: completion?.executionTrace,
      };
      artifacts.set(entry[0], located);
      return located;
    }),
    addAgentQuestion: vi.fn(async (_input: unknown, operationKey?: string) => {
      const key = operationKey ?? crypto.randomUUID();
      let id = questions.get(key);
      if (!id) {
        id = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
        questions.set(key, id);
      }
      return { id };
    }),
    addEvent: vi.fn(async () => undefined),
    recordAgentMessage: vi.fn(async () => undefined),
    transitionAgentMessage: vi.fn(async () => undefined),
    commitArtifact: vi.fn(async (_project: Project, _iteration: ProjectIteration, artifact: ProjectArtifact) => ({
      path: `artifacts/${artifact.id}.md`,
      branch: 'iteration-1-agents',
      url: `https://forgejo.example/artifacts/${artifact.id}.md`,
    })),
    addIterationComment: vi.fn(async () => undefined),
    addIterationCommentOnce: vi.fn(async () => undefined),
    labelIterationAgent: vi.fn(async () => undefined),
  };
});

vi.mock('@orchestra/database', () => ({
  defaultMigrationsFolder: '/migrations',
  normalizeDecisionKey: (value: string) => value,
  ProjectStore: class {
    migrate = mocks.migrate;
    addArtifact = mocks.addArtifact;
    loadArtifactOperationDraft = mocks.loadArtifactOperationDraft;
    locateArtifact = mocks.locateArtifact;
    addAgentQuestion = mocks.addAgentQuestion;
    addEvent = mocks.addEvent;
    recordAgentMessage = mocks.recordAgentMessage;
    transitionAgentMessage = mocks.transitionAgentMessage;
  },
}));

vi.mock('./forgejo.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./forgejo.js')>(),
  commitArtifact: mocks.commitArtifact,
  addIterationComment: mocks.addIterationComment,
  addIterationCommentOnce: mocks.addIterationCommentOnce,
  labelIterationAgent: mocks.labelIterationAgent,
}));

import { agentArtifactChildOperationKey, loadAgentArtifactOperationDraft, recordAgentArtifact, recordAgentHandoff } from './activities.js';

describe('recordAgentArtifact idempotency', () => {
  beforeEach(() => {
    mocks.artifacts.clear();
    mocks.manifests.clear();
    mocks.snapshots.clear();
    mocks.questions.clear();
    vi.clearAllMocks();
  });

  it('derives stable child keys and skips repository side effects on a completed retry', async () => {
    const project: Project = {
      id: 'd67a2fd5-e829-40dc-a6f5-d15e4758515d',
      name: 'Replay-safe studio',
      intent: 'Persist an agent result once.',
      audience: 'Operators',
      success: 'Retries return the same artifacts.',
      constraints: [],
      status: 'building',
      currentIteration: 1,
      previewUrl: null,
      repositoryUrl: 'https://forgejo.example/replay-safe-studio',
      repositoryOwner: 'orchestra',
      repositoryName: 'replay-safe-studio',
      createdAt: '2026-08-04T12:00:00.000Z',
      updatedAt: '2026-08-04T12:00:00.000Z',
    };
    const iteration: ProjectIteration = {
      id: 'e67a2fd5-e829-40dc-a6f5-d15e4758515d',
      projectId: project.id,
      number: 1,
      objective: 'Record the output once.',
      status: 'active',
      startedAt: '2026-08-04T12:00:00.000Z',
      completedAt: null,
      issueNumber: 1,
      branchName: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
    };
    const draft: AgentArtifactDraft = {
      type: 'build-submission',
      name: 'Build submission',
      content: '# Build submission',
      mimeType: 'text/markdown',
      producedBy: 'builder',
      model: 'qwen3.5:9b',
      attachments: [{
        type: 'source-file:src/index.ts',
        name: 'Source',
        content: 'export const ready = true;',
        mimeType: 'text/plain',
      }],
      questions: [{
        decisionKey: 'release.channel',
        question: 'Which release channel should be used?',
        options: [{ value: 'preview', label: 'Preview' }],
        allowCustomAnswer: false,
        allowAgentDecide: false,
      }],
    };

    const first = await recordAgentArtifact(project, iteration, draft, 'agent-order-42:record');
    const replay = await recordAgentArtifact(project, iteration, draft, 'agent-order-42:record');

    expect(replay).toEqual(first);
    await expect(loadAgentArtifactOperationDraft(project.id, 'agent-order-42:record')).resolves.toEqual(draft);
    expect(mocks.addArtifact.mock.calls.map((call) => call[4])).toEqual([
      'agent-order-42:record:artifact:0',
      'agent-order-42:record:artifact:1',
      'agent-order-42:record:artifact:0',
      'agent-order-42:record:artifact:1',
    ]);
    const manifests = mocks.addArtifact.mock.calls.map((call) => call[5]?.operationManifestHash);
    expect(manifests[0]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(manifests.every((manifest) => manifest === manifests[0])).toBe(true);
    expect(mocks.addAgentQuestion.mock.calls.map((call) => call[1])).toEqual([
      'agent-order-42:record:question:0',
      'agent-order-42:record:question:0',
    ]);
    expect(mocks.commitArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.locateArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.addIterationComment).not.toHaveBeenCalled();
    expect(mocks.addIterationCommentOnce.mock.calls.map((call) => call[3])).toEqual([
      'agent-order-42:record:artifact:0:comment',
      'agent-order-42:record:artifact:1:comment',
      'agent-order-42:record:artifact:0:comment',
      'agent-order-42:record:artifact:1:comment',
    ]);
    expect(agentArtifactChildOperationKey('root', 'question', 3)).toBe('root:question:3');

    await expect(recordAgentArtifact(project, iteration, {
      ...draft,
      attachments: [],
    }, 'agent-order-42:record')).rejects.toThrow('already used with a different payload');
  });

  it('keeps revision-bound assurance evidence out of the candidate branch', async () => {
    const project = {
      id: 'd67a2fd5-e829-40dc-a6f5-d15e4758515d', name: 'Frozen candidate', intent: 'Keep evidence separate.',
      audience: 'Reviewers', success: 'The tested revision does not move.', constraints: [], status: 'reviewing' as const,
      currentIteration: 1, previewUrl: 'https://preview.example', repositoryUrl: 'https://forgejo.example/frozen',
      repositoryOwner: 'orchestra', repositoryName: 'frozen', createdAt: '2026-08-04T12:00:00.000Z', updatedAt: '2026-08-04T12:00:00.000Z',
    } satisfies Project;
    const iteration = {
      id: 'e67a2fd5-e829-40dc-a6f5-d15e4758515d', projectId: project.id, number: 1, objective: 'Assure one SHA.',
      status: 'active' as const, startedAt: '2026-08-04T12:00:00.000Z', completedAt: null, issueNumber: 1,
      branchName: 'iteration-1-agents', pullRequestNumber: 1, pullRequestUrl: 'https://forgejo.example/frozen/pulls/1',
    } satisfies ProjectIteration;
    const revision = 'a'.repeat(40);

    const recorded = await recordAgentArtifact(project, iteration, {
      type: 'gate-decision', name: 'Gate decision', content: '# Pass', mimeType: 'text/markdown',
      producedBy: 'gate', model: 'model', gateDecision: { status: 'pass', rationale: 'Evidence is complete.', missingEvidence: [] },
    }, 'gate-order:record', { storage: 'ledger', sourceRevision: revision });

    expect(recorded.artifacts).toHaveLength(1);
    expect(recorded.artifacts[0]).toMatchObject({ repositoryPath: null, repositoryUrl: null, byteLength: 6 });
    expect(recorded.artifacts[0]?.content).toBeUndefined();
    expect(recorded.artifacts[0]?.contentAddress).toMatch(/^orchestra-artifact:\/\/postgres\//);
    expect(mocks.addArtifact.mock.calls[0]?.[5]).toMatchObject({ stageForRepository: false, sourceRevision: revision });
    expect(mocks.commitArtifact).not.toHaveBeenCalled();
    expect(mocks.locateArtifact).not.toHaveBeenCalled();
    expect(mocks.addIterationCommentOnce).not.toHaveBeenCalled();
  });

  it('uses one stable event and comment identity when a handoff is retried', async () => {
    const project = {
      id: 'd67a2fd5-e829-40dc-a6f5-d15e4758515d', name: 'Handoff studio', intent: 'Deliver once.',
      audience: 'Operators', success: 'Handoff retries converge.', constraints: [], status: 'building' as const,
      currentIteration: 1, previewUrl: null, repositoryUrl: 'https://forgejo.example/handoff',
      repositoryOwner: 'orchestra', repositoryName: 'handoff', createdAt: '2026-08-04T12:00:00.000Z',
      updatedAt: '2026-08-04T12:00:00.000Z',
    } satisfies Project;
    const iteration = {
      id: 'e67a2fd5-e829-40dc-a6f5-d15e4758515d', projectId: project.id, number: 1,
      objective: 'Deliver once.', status: 'active' as const, startedAt: '2026-08-04T12:00:00.000Z',
      completedAt: null, issueNumber: 1, branchName: 'iteration-1-agents', pullRequestNumber: null,
      pullRequestUrl: null,
    } satisfies ProjectIteration;
    const artifact = {
      id: 'a67a2fd5-e829-40dc-a6f5-d15e4758515d', projectId: project.id, iterationId: iteration.id,
      type: 'requirements-baseline', name: 'Requirements baseline', version: 1, content: '# Requirements',
      mimeType: 'text/markdown', status: 'ready_for_review' as const, producedBy: 'requirements' as const,
      model: 'model', repositoryPath: 'requirements.md', repositoryUrl: 'https://forgejo.example/requirements.md',
      createdAt: '2026-08-04T12:00:00.000Z', reviewedAt: null,
    } satisfies ProjectArtifact;

    await recordAgentHandoff(project, iteration, 'requirements', [artifact], ['ux'], 'actor_mailbox');
    await recordAgentHandoff(project, iteration, 'requirements', [artifact], ['ux'], 'actor_mailbox');

    expect(mocks.addEvent.mock.calls[0]?.[1]).toMatch(/:handoff:.*:mailbox-v1:event$/u);
    expect(mocks.addEvent.mock.calls[1]?.[1]).toBe(mocks.addEvent.mock.calls[0]?.[1]);
    expect(mocks.addIterationCommentOnce.mock.calls[0]?.[3]).toMatch(/:handoff:.*:mailbox-v1:comment$/u);
    expect(mocks.addIterationCommentOnce.mock.calls[1]?.[3]).toBe(mocks.addIterationCommentOnce.mock.calls[0]?.[3]);
  });
});
