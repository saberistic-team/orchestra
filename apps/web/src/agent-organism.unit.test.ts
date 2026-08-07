import type { AgentInteraction, IterationReviewProposal, MessageThread, ProjectArtifact, ProjectDetail } from '@orchestra/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildGraphEdges,
  deriveIterationReadiness,
  filterActivityInteractions,
  formatElapsed,
  normalizeAgentState,
  selectCanonicalAgentSpotlight,
  selectInteractionThreads,
  summarizeAgentModelUsage,
} from './AgentOrganism.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const iterationId = '22222222-2222-4222-8222-222222222222';
const readyAgentPositions = {
  manager: 'ready',
  requirements: 'ready',
  product: 'ready',
  ux: 'ready',
  architecture: 'ready',
  data: 'ready',
  security: 'ready',
  planner: 'ready',
  builder: 'ready',
  test: 'ready',
  reviewer: 'ready',
  gate: 'ready',
  deployment: 'not_required',
  validation: 'not_required',
} as const;

function projectDetail(): ProjectDetail {
  return {
    project: {
      id: projectId,
      name: 'Living organism',
      intent: 'Deliver a truthful real-time graph of the whole organization.',
      audience: 'Delivery teams',
      success: 'Every runtime state is understandable and evidence-backed.',
      constraints: [],
      status: 'building',
      currentIteration: 1,
      previewUrl: null,
      repositoryUrl: null,
      repositoryOwner: null,
      repositoryName: null,
      createdAt: '2026-08-04T15:00:00.000Z',
      updatedAt: '2026-08-04T16:00:00.000Z',
    },
    iterations: [{
      id: iterationId,
      projectId,
      number: 1,
      objective: 'Make coordination visible without implying work that did not happen.',
      status: 'active',
      startedAt: '2026-08-04T15:00:00.000Z',
      completedAt: null,
      issueNumber: null,
      branchName: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
    }],
    events: [],
    artifacts: [],
    media: [],
  };
}

function artifact(overrides: Partial<ProjectArtifact>): ProjectArtifact {
  return {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    iterationId: crypto.randomUUID(),
    type: 'project-charter',
    name: 'Project charter',
    version: 1,
    content: '# Charter',
    mimeType: 'text/markdown',
    status: 'ready_for_review',
    producedBy: 'manager',
    model: 'qwen/qwen3.5-9b',
    repositoryPath: null,
    repositoryUrl: null,
    createdAt: '2026-08-04T16:00:00.000Z',
    reviewedAt: null,
    ...overrides,
  };
}

function reviewProposal(overrides: Partial<IterationReviewProposal> = {}): IterationReviewProposal {
  return {
    id: 'proposal-current',
    projectId,
    iterationId,
    iterationNumber: 1,
    type: 'iteration_review_proposal',
    proposalVersion: 1,
    status: 'proposed',
    objectiveStatus: 'satisfied',
    includedRevision: 'revision-current',
    completedOutcomes: ['The current increment is reviewable.'],
    openFindings: [],
    agentPositions: readyAgentPositions,
    gateStatus: 'pass',
    gateRationale: 'Mandatory evidence passed for the current revision.',
    managerRationale: 'The current revision is ready for human review.',
    recommendation: 'send_for_human_review',
    knownLimitations: [],
    budgetSnapshot: {
      modelInvocationCount: 0,
      totalTokens: 0,
      openRouterCostUsd: 0,
      repositoryOperationCount: 0,
      activeMutationCount: 0,
    },
    createdAt: '2026-08-04T16:20:00.000Z',
    ...overrides,
  };
}

type GoalRecord = NonNullable<ProjectDetail['agentGoals']>[number];
type PlanRecord = NonNullable<ProjectDetail['agentActionPlans']>[number];
type ActionRecord = NonNullable<ProjectDetail['agentActions']>[number];
type ObligationRecord = NonNullable<ProjectDetail['agentObligations']>[number];
type ArtifactVersionRecord = NonNullable<ProjectDetail['artifactVersions']>[number];
type FindingRecord = NonNullable<ProjectDetail['findings']>[number];
type ModelInvocationRecord = NonNullable<ProjectDetail['modelInvocations']>[number];
type RepositoryOperationRecord = NonNullable<ProjectDetail['repositoryOperations']>[number];

function goalRecord(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: crypto.randomUUID(), projectId, iterationId, role: 'manager', objective: 'Coordinate the current iteration.', status: 'active', priority: 'high', successCriteria: [], correlationId: null,
    createdAt: '2026-08-04T16:00:00.000Z', updatedAt: '2026-08-04T16:00:00.000Z', completedAt: null, ...overrides,
  };
}

function planRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: crypto.randomUUID(), projectId, iterationId, role: 'manager', goalId: null, version: 1, summary: 'Coordinate the bounded work.', rationale: null, status: 'active', sourceRevision: null, correlationId: null,
    createdAt: '2026-08-04T16:00:00.000Z', updatedAt: '2026-08-04T16:00:00.000Z', completedAt: null, ...overrides,
  };
}

function actionRecord(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: crypto.randomUUID(), projectId, iterationId, role: 'manager', planId: null, position: 0, kind: 'coordinate', summary: 'Coordinate the next handoff.', status: 'pending', blocking: false, dependencyActionIds: [], input: {}, output: null, error: null, correlationId: null,
    createdAt: '2026-08-04T16:00:00.000Z', updatedAt: '2026-08-04T16:00:00.000Z', startedAt: null, completedAt: null, ...overrides,
  };
}

function obligationRecord(overrides: Partial<ObligationRecord> = {}): ObligationRecord {
  return {
    id: crypto.randomUUID(), projectId, iterationId, ownerRole: 'manager', goalId: null, actionId: null, type: 'review', title: 'Review the current evidence.', description: 'Check the evidence before proposing review.', status: 'pending', priority: 'normal', mandatory: true, blocking: false, subjectReferences: [], dependencyReferences: [], satisfactionEvidence: [], disposition: null, sourceRevision: null, correlationId: null, dueAt: null,
    createdAt: '2026-08-04T16:00:00.000Z', updatedAt: '2026-08-04T16:00:00.000Z', satisfiedAt: null, ...overrides,
  };
}

function artifactVersionRecord(overrides: Partial<ArtifactVersionRecord> = {}): ArtifactVersionRecord {
  return {
    id: crypto.randomUUID(), projectId, iterationId, artifactId: crypto.randomUUID(), artifactType: 'project-charter', artifactName: 'Project charter', producedByRole: 'manager', version: 1, status: 'ready_for_review', content: '# Charter', mimeType: 'text/markdown', contentHash: null, storageUri: null, repositoryPath: null, sourceRevision: null, supersedesVersionId: null, metadata: {}, createdAt: '2026-08-04T16:00:00.000Z', ...overrides,
  };
}

function findingRecord(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: crypto.randomUUID(), projectId, iterationId, raisedByRole: 'reviewer', ownerRole: 'manager', obligationId: null, actionId: null, artifactVersionId: null, category: 'readiness', title: 'Readiness evidence needs disposition.', description: 'A recorded finding remains unresolved.', severity: 'high', status: 'open', disposition: 'block_iteration', subjectReferences: [], evidenceReferences: [], sourceRevision: null, correlationId: null,
    createdAt: '2026-08-04T16:00:00.000Z', updatedAt: '2026-08-04T16:00:00.000Z', resolvedAt: null, ...overrides,
  };
}

function modelInvocationRecord(overrides: Partial<ModelInvocationRecord> = {}): ModelInvocationRecord {
  return {
    id: crypto.randomUUID(), projectId, iterationId, role: 'manager', actionId: null, provider: 'openrouter', model: 'qwen/qwen3.5-9b', purpose: 'coordinate', status: 'succeeded', externalRequestId: null, inputTokens: 100, outputTokens: 50, cachedTokens: 0, totalTokens: 150, costUsd: 0.002, requestMetadata: {}, responseMetadata: {}, error: null, correlationId: null,
    createdAt: '2026-08-04T16:00:00.000Z', startedAt: '2026-08-04T16:00:01.000Z', completedAt: '2026-08-04T16:00:02.000Z', ...overrides,
  };
}

function repositoryOperationRecord(overrides: Partial<RepositoryOperationRecord> = {}): RepositoryOperationRecord {
  return {
    id: crypto.randomUUID(), projectId, iterationId, role: 'manager', actionId: null, lifecycleRecordId: null, type: 'inspect_revision', status: 'completed', mutating: false, repositoryUrl: null, branchName: null, paths: [], expectedBaseRevision: null, resultingRevision: null, externalId: null, summary: 'Inspected the candidate revision.', metadata: {}, correlationId: null,
    createdAt: '2026-08-04T16:00:00.000Z', startedAt: '2026-08-04T16:00:01.000Z', completedAt: '2026-08-04T16:00:02.000Z', ...overrides,
  };
}

describe('selected agent model usage', () => {
  it('totals primary artifacts without double-counting copied attachment metadata', () => {
    const invocation = {
      provider: 'openrouter' as const,
      model: 'qwen/qwen3.5-9b',
      purpose: 'generate' as const,
      round: 0,
      requestId: 'generation-123',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.0025 },
    };
    const result = summarizeAgentModelUsage([
      artifact({ modelProvider: 'openrouter', modelInvocations: [invocation] }),
      artifact({ type: 'user-flow-diagram', modelProvider: 'openrouter', modelInvocations: [invocation] }),
      artifact({
        id: crypto.randomUUID(),
        modelProvider: 'ollama',
        modelInvocations: [{ model: 'qwen3.5:9b', provider: 'ollama', purpose: 'quality_review', round: 0, usage: { promptTokens: 80, completionTokens: 20 } }],
      }),
    ], 'manager', 'project-charter');

    expect(result).toEqual({
      requests: 2,
      totalTokens: 250,
      promptTokens: 180,
      completionTokens: 70,
      reasoningTokens: 0,
      openRouterRequests: 1,
      openRouterCost: 0.0025,
      openRouterCostReported: true,
    });
  });

  it('includes reported reasoning tokens in the usage summary', () => {
    const result = summarizeAgentModelUsage([
      artifact({
        modelProvider: 'openrouter',
        modelInvocations: [{
          provider: 'openrouter',
          model: 'openai/gpt-5-mini',
          purpose: 'generate',
          round: 0,
          usage: { promptTokens: 40, completionTokens: 120, reasoningTokens: 35, totalTokens: 160 },
        }],
      }),
    ], 'manager', 'project-charter');
    expect(result.reasoningTokens).toBe(35);
  });
});

describe('canonical selected-agent spotlight', () => {
  it('selects only current-iteration records attributable to the selected role', () => {
    const detail = projectDetail();
    const oldIterationId = '77777777-7777-4777-8777-777777777777';
    const managerActionId = '88888888-8888-4888-8888-888888888888';
    const requirementsActionId = '99999999-9999-4999-8999-999999999999';
    const artifactId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    detail.agentGoals = [
      goalRecord({ id: '10000000-0000-4000-8000-000000000001', updatedAt: '2026-08-04T16:10:00.000Z' }),
      goalRecord({ id: '10000000-0000-4000-8000-000000000002', role: 'requirements', updatedAt: '2026-08-04T16:20:00.000Z' }),
      goalRecord({ id: '10000000-0000-4000-8000-000000000003', iterationId: oldIterationId, updatedAt: '2026-08-04T16:30:00.000Z' }),
    ];
    detail.agentActionPlans = [
      planRecord({ id: '20000000-0000-4000-8000-000000000001', version: 2, sourceRevision: 'revision-current' }),
      planRecord({ id: '20000000-0000-4000-8000-000000000002', role: 'requirements' }),
    ];
    detail.agentActions = [
      actionRecord({ id: managerActionId, status: 'completed', completedAt: '2026-08-04T16:10:00.000Z', updatedAt: '2026-08-04T16:10:00.000Z' }),
      actionRecord({ id: '88888888-8888-4888-8888-888888888889', status: 'pending', position: 1, updatedAt: '2026-08-04T16:11:00.000Z' }),
      actionRecord({ id: requirementsActionId, role: 'requirements', updatedAt: '2026-08-04T16:12:00.000Z' }),
      actionRecord({ id: '88888888-8888-4888-8888-888888888887', iterationId: oldIterationId, updatedAt: '2026-08-04T16:13:00.000Z' }),
    ];
    detail.agentObligations = [
      obligationRecord({ id: '30000000-0000-4000-8000-000000000001', status: 'pending' }),
      obligationRecord({ id: '30000000-0000-4000-8000-000000000002', status: 'satisfied', satisfiedAt: '2026-08-04T16:15:00.000Z' }),
      obligationRecord({ id: '30000000-0000-4000-8000-000000000003', ownerRole: 'requirements' }),
    ];
    detail.artifactVersions = [
      artifactVersionRecord({ id: '40000000-0000-4000-8000-000000000001', artifactId, version: 1, status: 'superseded', createdAt: '2026-08-04T16:00:00.000Z' }),
      artifactVersionRecord({ id: '40000000-0000-4000-8000-000000000002', artifactId, version: 2, status: 'ready_for_review', sourceRevision: 'revision-current', createdAt: '2026-08-04T16:15:00.000Z' }),
      artifactVersionRecord({ id: '40000000-0000-4000-8000-000000000003', producedByRole: 'requirements' }),
    ];
    detail.findings = [
      findingRecord({ id: '50000000-0000-4000-8000-000000000001', status: 'open' }),
      findingRecord({ id: '50000000-0000-4000-8000-000000000002', status: 'resolved', resolvedAt: '2026-08-04T16:10:00.000Z' }),
      findingRecord({ id: '50000000-0000-4000-8000-000000000003', ownerRole: 'requirements' }),
    ];
    detail.modelInvocations = [
      modelInvocationRecord({ id: '60000000-0000-4000-8000-000000000001' }),
      modelInvocationRecord({ id: '60000000-0000-4000-8000-000000000002', role: null, actionId: managerActionId }),
      modelInvocationRecord({ id: '60000000-0000-4000-8000-000000000003', role: null, actionId: requirementsActionId }),
      modelInvocationRecord({ id: '60000000-0000-4000-8000-000000000004', iterationId: oldIterationId }),
    ];
    detail.repositoryOperations = [
      repositoryOperationRecord({ id: '70000000-0000-4000-8000-000000000001' }),
      repositoryOperationRecord({ id: '70000000-0000-4000-8000-000000000002', role: null, actionId: managerActionId }),
      repositoryOperationRecord({ id: '70000000-0000-4000-8000-000000000003', role: null, actionId: requirementsActionId }),
      repositoryOperationRecord({ id: '70000000-0000-4000-8000-000000000004', iterationId: oldIterationId }),
    ];

    const view = selectCanonicalAgentSpotlight(detail, 'manager');
    expect(view.available).toBe(true);
    expect(view.currentGoal?.id).toBe('10000000-0000-4000-8000-000000000001');
    expect(view.currentPlan).toMatchObject({ id: '20000000-0000-4000-8000-000000000001', version: 2, sourceRevision: 'revision-current' });
    expect(view.actions.map((record) => record.id)).toEqual(['88888888-8888-4888-8888-888888888889', managerActionId]);
    expect(view.obligations).toHaveLength(2);
    expect(view.findings.map((record) => record.id)).toEqual(['50000000-0000-4000-8000-000000000001']);
    expect(view.artifactVersions).toMatchObject([{ artifactId, version: 2, sourceRevision: 'revision-current' }]);
    expect(view.modelInvocations.map((record) => record.id)).toEqual([
      '60000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000002',
    ]);
    expect(view.repositoryOperations.map((record) => record.id)).toEqual([
      '70000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000002',
    ]);
  });

  it('distinguishes an available but empty canonical projection from unavailable data', () => {
    const available = projectDetail();
    available.agentGoals = [];
    available.agentActionPlans = [];
    available.agentActions = [];
    available.agentObligations = [];
    available.artifactVersions = [];
    available.findings = [];
    available.modelInvocations = [];
    available.repositoryOperations = [];

    expect(selectCanonicalAgentSpotlight(available, 'manager')).toMatchObject({
      available: true,
      currentGoal: undefined,
      currentPlan: undefined,
      actions: [],
      obligations: [],
      findings: [],
      artifactVersions: [],
      modelInvocations: [],
      repositoryOperations: [],
    });
    expect(selectCanonicalAgentSpotlight(projectDetail(), 'manager').available).toBe(false);
  });
});

describe('agent runtime state compatibility', () => {
  it('maps legacy snapshots into the explicit runtime vocabulary', () => {
    expect([
      normalizeAgentState('dormant'),
      normalizeAgentState('waiting'),
      normalizeAgentState('active'),
      normalizeAgentState('completed'),
      normalizeAgentState('reviewing'),
      normalizeAgentState(undefined),
    ]).toEqual([
      'observing',
      'waiting_on_agent',
      'working',
      'completed_for_iteration',
      'reviewing',
      'observing',
    ]);
  });

  it('formats elapsed activity from the ticker value supplied by the view', () => {
    const startedAt = '2026-08-04T16:00:00.000Z';
    expect(formatElapsed(startedAt, Date.parse(startedAt) + 5_000)).toBe('5s');
    expect(formatElapsed(startedAt, Date.parse(startedAt) + 65_000)).toBe('1m');
  });
});

describe('durable interaction threads', () => {
  it('groups correlated messages, participants, and live status', () => {
    const interactions: AgentInteraction[] = [
      {
        id: 'finding-1',
        messageId: 'message-finding',
        correlationId: 'topic-auth',
        iterationNumber: 1,
        from: 'security',
        to: ['builder'],
        kind: 'finding',
        name: 'Authorization boundary is incomplete',
        summary: 'A privileged action needs an explicit ownership check.',
        status: 'in_progress',
        createdAt: '2026-08-04T16:05:00.000Z',
        live: true,
      },
      {
        id: 'ack-1',
        messageId: 'message-ack',
        correlationId: 'topic-auth',
        iterationNumber: 1,
        from: 'builder',
        to: ['security'],
        kind: 'acknowledgement',
        name: 'Finding acknowledged',
        summary: 'Builder accepted the remediation request.',
        status: 'completed',
        createdAt: '2026-08-04T16:04:00.000Z',
        live: false,
      },
    ];

    expect(selectInteractionThreads(interactions)).toEqual([{
      id: 'thread:topic-auth',
      correlationId: 'topic-auth',
      title: 'Finding acknowledged',
      participantRoles: ['security', 'builder'],
      messageIds: ['message-finding', 'message-ack'],
      status: 'active',
      updatedAt: '2026-08-04T16:05:00.000Z',
    }]);
  });

  it('preserves supplied thread identity and resolution', () => {
    const supplied: MessageThread = {
      id: 'thread-review',
      correlationId: 'topic-review',
      title: 'Review disposition',
      participantRoles: ['reviewer', 'builder'],
      messageIds: ['review-1'],
      artifactIds: [],
      findingIds: [],
      status: 'resolved',
      updatedAt: '2026-08-04T16:10:00.000Z',
    };

    expect(selectInteractionThreads([], [supplied])).toEqual([{
      id: 'thread-review',
      correlationId: 'topic-review',
      title: 'Review disposition',
      participantRoles: ['reviewer', 'builder'],
      messageIds: ['review-1'],
      status: 'resolved',
      updatedAt: '2026-08-04T16:10:00.000Z',
    }]);
  });

  it('keeps completed non-dependency communication paths selectable without marking them live', () => {
    const completed: AgentInteraction = {
      id: 'historical-answer',
      messageId: 'historical-answer-message',
      correlationId: 'topic-outcome',
      iterationNumber: 1,
      from: 'validation',
      to: ['requirements'],
      kind: 'answer',
      name: 'Outcome question answered',
      summary: 'Validation supplied the recorded scenario result.',
      status: 'completed',
      createdAt: '2026-08-04T16:15:00.000Z',
      live: false,
    };
    const thread = selectInteractionThreads([completed]);
    const edge = buildGraphEdges([completed], thread).find((candidate) => candidate.id === 'validation:requirements');

    expect(edge).toMatchObject({
      kind: 'message',
      interactions: [completed],
      threadIds: ['thread:topic-outcome'],
    });
    expect(edge?.activeInteraction).toBeUndefined();
  });
});

describe('activity stream dimensions', () => {
  it('filters only on directly recorded iteration, artifact, finding, human, model, and repository evidence', () => {
    const linkedArtifact = artifact({
      id: '33333333-3333-4333-8333-333333333333',
      projectId,
      iterationId,
      repositoryPath: 'artifacts/iteration-01/charter.md',
      repositoryUrl: 'https://git.example.test/orchestra/charter',
      modelInvocations: [{
        provider: 'openrouter',
        model: 'qwen/qwen3.5-9b',
        purpose: 'generate',
        round: 0,
        requestId: 'request-linked-artifact',
      }],
    });
    const interactions: AgentInteraction[] = [
      {
        id: 'artifact-message',
        iterationNumber: 2,
        from: 'manager',
        to: ['requirements'],
        kind: 'handoff',
        name: 'Charter handoff',
        summary: 'The charter artifact was delivered.',
        status: 'completed',
        createdAt: '2026-08-04T16:10:00.000Z',
        artifactRefs: [{ artifactId: linkedArtifact.id, artifactType: linkedArtifact.type, version: '1' }],
      },
      {
        id: 'finding-message',
        iterationNumber: 1,
        from: 'security',
        to: ['builder'],
        kind: 'finding',
        name: 'Finding opened',
        summary: 'A finding was recorded without an artifact reference.',
        status: 'blocked',
        createdAt: '2026-08-04T16:09:00.000Z',
      },
      {
        id: 'human-message',
        iterationNumber: 1,
        from: 'human',
        to: ['manager'],
        kind: 'answer',
        name: 'Human decision recorded',
        summary: 'The human supplied a decision.',
        status: 'completed',
        createdAt: '2026-08-04T16:08:00.000Z',
      },
    ];

    expect(filterActivityInteractions(interactions, { iterationNumber: 2 }).map((item) => item.id)).toEqual(['artifact-message']);
    expect(filterActivityInteractions(interactions, { dimension: 'artifact', artifacts: [linkedArtifact] }).map((item) => item.id)).toEqual(['artifact-message']);
    expect(filterActivityInteractions(interactions, { dimension: 'finding', artifacts: [linkedArtifact] }).map((item) => item.id)).toEqual(['finding-message']);
    expect(filterActivityInteractions(interactions, { dimension: 'human', artifacts: [linkedArtifact] }).map((item) => item.id)).toEqual(['human-message']);
    expect(filterActivityInteractions(interactions, { dimension: 'model', artifacts: [linkedArtifact] }).map((item) => item.id)).toEqual(['artifact-message']);
    expect(filterActivityInteractions(interactions, { dimension: 'repository', artifacts: [linkedArtifact] }).map((item) => item.id)).toEqual(['artifact-message']);
    expect(filterActivityInteractions(interactions, { dimension: 'model', artifacts: [] })).toEqual([]);
  });
});

describe('iteration readiness', () => {
  it('uses the recorded readiness projection when no persisted proposal exists', () => {
    const detail = projectDetail();
    detail.executionGraph = {
      iterationNumber: 1,
      graphVersion: 2,
      nodes: [],
      edges: [],
      modelConcurrency: 3,
      readiness: {
        objectiveStatus: 'satisfied_with_known_gaps',
        includedRevision: 'abc123',
        items: [{ id: 'preview', label: 'Runnable preview', status: 'ready', summary: 'Preview revision abc123 is available.' }],
        openCriticalFindings: 0,
        openHighFindings: 1,
        pendingHumanDecisions: 0,
        gateStatus: 'pass',
        managerRecommendation: 'send_for_human_review',
        managerRationale: 'The objective is met and the remaining high finding is explicitly dispositioned.',
      },
    };

    expect(deriveIterationReadiness(detail)).toMatchObject({
      source: 'recorded',
      objectiveStatus: 'Satisfied With Known Gaps',
      gateStatus: 'Pass',
      managerRecommendation: 'Manager recommends human review',
      managerRationale: 'The objective is met and the remaining high finding is explicitly dispositioned.',
      openCriticalFindings: 0,
      openHighFindings: 1,
      pendingHumanDecisions: 0,
    });
  });

  it('uses the newest persisted proposal for the current iteration over an older runtime projection', () => {
    const detail = projectDetail();
    detail.media = [{
      id: '55555555-5555-4555-8555-555555555556',
      projectId,
      iterationId,
      kind: 'preview',
      title: 'Current iteration preview',
      url: 'https://preview.example.test',
      sourceRevision: 'revision-newest',
      imageDigest: null,
      expiresAt: null,
      createdAt: '2026-08-04T16:19:00.000Z',
    }];
    detail.executionGraph = {
      iterationNumber: 1,
      graphVersion: 2,
      nodes: [],
      edges: [],
      modelConcurrency: 3,
      readiness: {
        objectiveStatus: 'satisfied',
        includedRevision: 'stale-runtime-revision',
        items: [{ id: 'preview', label: 'Runnable preview', status: 'ready', summary: 'Preview is available.' }],
        openCriticalFindings: 0,
        openHighFindings: 0,
        pendingHumanDecisions: 0,
        gateStatus: 'pass',
        managerRecommendation: 'send_for_human_review',
        managerRationale: 'This runtime projection is older than the durable proposal.',
      },
    };
    detail.iterationReviewProposals = [
      {
        id: 'proposal-newest',
        projectId,
        iterationId,
        iterationNumber: 1,
        type: 'iteration_review_proposal',
        proposalVersion: 2,
        status: 'gate_blocked',
        objectiveStatus: 'satisfied_with_known_gaps',
        includedRevision: 'revision-newest',
        completedOutcomes: ['The graph reports durable communication.'],
        openFindings: [
          { findingId: 'finding-critical', severity: 'critical', summary: 'Gate evidence is incomplete.', disposition: 'resolve_in_iteration' },
          { findingId: 'finding-human', severity: 'high', summary: 'Risk ownership needs a person.', disposition: 'human_decision_required' },
        ],
        agentPositions: { ...readyAgentPositions, gate: 'not_ready' },
        gateStatus: 'blocked',
        gateRationale: 'Gate evidence is incomplete.',
        managerRationale: 'The latest proposal records a blocked gate and one human decision.',
        recommendation: 'request_human_decision',
        knownLimitations: ['Gate evidence is incomplete.'],
        budgetSnapshot: {
          modelInvocationCount: 0,
          totalTokens: 0,
          openRouterCostUsd: 0,
          repositoryOperationCount: 0,
          activeMutationCount: 0,
        },
        createdAt: '2026-08-04T16:20:00.000Z',
      },
      {
        id: 'proposal-older',
        projectId,
        iterationId,
        iterationNumber: 1,
        type: 'iteration_review_proposal',
        proposalVersion: 1,
        status: 'proposed',
        objectiveStatus: 'satisfied',
        includedRevision: 'revision-older',
        completedOutcomes: [],
        openFindings: [],
        agentPositions: readyAgentPositions,
        gateStatus: 'pass',
        gateRationale: 'Gate evidence passed.',
        managerRationale: 'The older proposal recommended review.',
        recommendation: 'send_for_human_review',
        knownLimitations: [],
        budgetSnapshot: {
          modelInvocationCount: 0,
          totalTokens: 0,
          openRouterCostUsd: 0,
          repositoryOperationCount: 0,
          activeMutationCount: 0,
        },
        createdAt: '2026-08-04T16:10:00.000Z',
      },
    ];

    const readiness = deriveIterationReadiness(detail);
    expect(readiness).toMatchObject({
      source: 'proposal',
      objectiveStatus: 'Satisfied With Known Gaps',
      gateStatus: 'Blocked',
      managerRecommendation: 'Manager requests a human decision',
      managerRationale: 'The latest proposal records a blocked gate and one human decision.',
      openCriticalFindings: 1,
      openHighFindings: 1,
      pendingHumanDecisions: 1,
      includedRevision: 'revision-newest',
      proposedAt: '2026-08-04T16:20:00.000Z',
    });
    expect(readiness.items.find((item) => item.id === 'gate')?.status).toBe('blocked');
    expect(readiness.items.find((item) => item.id === 'agents')).toMatchObject({ status: 'blocked', current: 11, target: 12 });
    expect(readiness.items.find((item) => item.id === 'preview')?.status).toBe('ready');
  });

  it.each(['rejected', 'superseded'] as const)('does not present a %s proposal as current readiness', (status) => {
    const detail = projectDetail();
    detail.media = [{
      id: '55555555-5555-4555-8555-555555555557', projectId, iterationId, kind: 'preview', title: 'Current preview',
      url: 'https://preview.example.test', sourceRevision: 'revision-current', imageDigest: null, expiresAt: null,
      createdAt: '2026-08-04T16:10:00.000Z',
    }];
    detail.iterationReviewProposals = [reviewProposal({ status })];

    expect(deriveIterationReadiness(detail)).toMatchObject({
      source: 'fallback',
      managerRecommendation: 'Awaiting a recorded Manager recommendation',
    });
  });

  it('requires a proposal for the active preview revision and newer than current evidence', () => {
    const detail = projectDetail();
    detail.media = [{
      id: '55555555-5555-4555-8555-555555555558', projectId, iterationId, kind: 'preview', title: 'Current preview',
      url: 'https://preview.example.test', sourceRevision: 'revision-current', imageDigest: null, expiresAt: null,
      createdAt: '2026-08-04T16:10:00.000Z',
    }];
    detail.iterationReviewProposals = [
      reviewProposal({ id: 'proposal-wrong-revision', includedRevision: 'revision-old', createdAt: '2026-08-04T16:30:00.000Z' }),
      reviewProposal({ id: 'proposal-before-feedback', createdAt: '2026-08-04T16:20:00.000Z' }),
    ];
    detail.artifactFeedback = [{
      id: '77777777-7777-4777-8777-777777777777', projectId, iterationId,
      artifactId: '88888888-8888-4888-8888-888888888888', reviewId: null,
      feedback: 'Recheck the exact-revision evidence before review.', createdAt: '2026-08-04T16:21:00.000Z',
    }];

    expect(deriveIterationReadiness(detail)).toMatchObject({
      source: 'fallback',
      managerRecommendation: 'Awaiting a recorded Manager recommendation',
    });
  });

  it('derives a compatibility view from evidence without inventing a Manager recommendation', () => {
    const detail = projectDetail();
    detail.artifacts = [
      artifact({ id: '33333333-3333-4333-8333-333333333333', projectId, iterationId, type: 'project-charter', producedBy: 'manager' }),
      artifact({ id: '44444444-4444-4444-8444-444444444444', projectId, iterationId, type: 'test-evidence', producedBy: 'test' }),
    ];
    detail.media = [{
      id: '55555555-5555-4555-8555-555555555555',
      projectId,
      iterationId,
      kind: 'preview',
      title: 'Iteration preview',
      url: 'https://preview.example.test',
      sourceRevision: 'abc123',
      imageDigest: null,
      expiresAt: null,
      createdAt: '2026-08-04T16:00:00.000Z',
    }];
    detail.questions = [{
      id: '66666666-6666-4666-8666-666666666666',
      projectId,
      iterationId,
      agentRole: 'manager',
      decisionKey: 'manager.cutoff',
      reusedFromQuestionId: null,
      question: 'Should this iteration be proposed for review?',
      context: null,
      status: 'pending',
      allowCustomAnswer: true,
      allowAgentDecide: true,
      options: [],
      answer: null,
      createdAt: '2026-08-04T16:00:00.000Z',
      updatedAt: '2026-08-04T16:00:00.000Z',
    }];

    const readiness = deriveIterationReadiness(detail);
    expect(readiness.source).toBe('fallback');
    expect(readiness.managerRecommendation).toBe('Awaiting a recorded Manager recommendation');
    expect(readiness.managerRationale).toContain('without inventing a Manager cutoff proposal');
    expect(readiness.pendingHumanDecisions).toBe(1);
    expect(readiness.items.find((item) => item.id === 'preview')?.status).toBe('ready');
    expect(readiness.items.find((item) => item.id === 'tests')?.status).toBe('ready');
    expect(readiness.items.find((item) => item.id === 'artifacts')).toMatchObject({ current: 2, target: 12, status: 'waiting' });
  });
});
