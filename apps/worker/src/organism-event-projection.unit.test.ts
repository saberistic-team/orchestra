import {
  deliveryAgentGraph,
  organismEventSchema,
  type IterationReviewProposal,
  type ProjectDetail,
} from '@orchestra/contracts';
import { describe, expect, it } from 'vitest';
import { interactionFromOrganismEvent, projectOrganismEvents } from './organism-event-projection.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const iterationId = '22222222-2222-4222-8222-222222222222';
const artifactId = '33333333-3333-4333-8333-333333333333';
const now = '2026-08-04T12:00:00.000Z';

function detail(): ProjectDetail {
  const agentPositions = Object.fromEntries(deliveryAgentGraph.map((definition) => [
    definition.role,
    definition.role === 'deployment' || definition.role === 'validation' ? 'not_required' : 'ready',
  ])) as IterationReviewProposal['agentPositions'];
  return {
    project: {
      id: projectId,
      name: 'Typed organism',
      intent: 'Project only activity that is backed by durable typed records.',
      audience: 'Delivery teams',
      success: 'The graph consumes one canonical event vocabulary.',
      constraints: [],
      status: 'reviewing',
      currentIteration: 1,
      previewUrl: 'https://preview.example.test',
      repositoryUrl: null,
      repositoryOwner: null,
      repositoryName: null,
      createdAt: now,
      updatedAt: '2026-08-04T12:10:00.000Z',
    },
    iterations: [{
      id: iterationId,
      projectId,
      number: 1,
      objective: 'Use typed activity.',
      status: 'active',
      startedAt: now,
      completedAt: null,
      issueNumber: null,
      branchName: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
    }],
    events: [],
    artifacts: [],
    media: [{
      id: '44444444-4444-4444-8444-444444444444',
      projectId,
      iterationId,
      kind: 'preview',
      title: 'Review preview',
      url: 'https://preview.example.test',
      sourceRevision: 'a'.repeat(40),
      imageDigest: null,
      expiresAt: null,
      createdAt: '2026-08-04T12:08:00.000Z',
    }],
    agentRuntimeSnapshots: [{
      role: 'builder',
      state: 'working',
      activity: { type: 'implementation', summary: 'Implementing the approved work package.', startedAt: '2026-08-04T12:01:00.000Z' },
      stateChangedAt: '2026-08-04T12:01:00.000Z',
      mailboxDepth: 1,
      activeOrderCount: 1,
      blockerCount: 0,
      pendingQuestionCount: 0,
      graphVersion: 1,
      stateVersion: 4,
    }],
    agentMessages: [{
      id: 'message-1',
      messageId: 'protocol-message-1',
      correlationId: 'iteration:1:builder:test',
      iterationNumber: 1,
      from: 'builder',
      to: ['test'],
      kind: 'handoff',
      name: 'Build submission handoff',
      summary: 'Builder sent the immutable candidate to Test.',
      status: 'in_progress',
      createdAt: '2026-08-04T12:02:00.000Z',
      live: true,
    }],
    artifactVersions: [{
      id: '55555555-5555-4555-8555-555555555555',
      projectId,
      iterationId,
      artifactId,
      artifactType: 'build-submission',
      artifactName: 'Build submission',
      producedByRole: 'builder',
      version: 2,
      status: 'ready_for_review',
      content: '# Build',
      mimeType: 'text/markdown',
      contentHash: 'sha256:build',
      storageUri: null,
      repositoryPath: null,
      sourceRevision: 'a'.repeat(40),
      supersedesVersionId: null,
      metadata: {},
      createdAt: '2026-08-04T12:03:00.000Z',
    }],
    findings: [{
      id: '66666666-6666-4666-8666-666666666666',
      projectId,
      iterationId,
      raisedByRole: 'reviewer',
      ownerRole: 'builder',
      obligationId: null,
      actionId: null,
      artifactVersionId: null,
      category: 'correctness',
      title: 'Revision proof is missing',
      description: 'The evidence must name the exact revision.',
      severity: 'high',
      status: 'open',
      disposition: 'block_iteration',
      subjectReferences: [artifactId],
      evidenceReferences: [],
      sourceRevision: 'a'.repeat(40),
      correlationId: 'finding:revision-proof',
      createdAt: '2026-08-04T12:04:00.000Z',
      updatedAt: '2026-08-04T12:04:00.000Z',
      resolvedAt: null,
    }],
    iterationReviewProposals: [{
      id: 'proposal-1',
      projectId,
      iterationId,
      iterationNumber: 1,
      type: 'iteration_review_proposal',
      proposalVersion: 1,
      status: 'gate_blocked',
      objectiveStatus: 'partially_satisfied',
      includedRevision: 'a'.repeat(40),
      completedOutcomes: ['The current candidate exists.'],
      openFindings: [{ severity: 'high', summary: 'Revision proof is missing.', disposition: 'resolve_in_iteration' }],
      agentPositions,
      gateStatus: 'blocked',
      gateRationale: 'The revision-bound proof is incomplete.',
      managerRationale: 'Continue the iteration to repair the missing proof.',
      recommendation: 'continue_iteration',
      knownLimitations: [],
      budgetSnapshot: { modelInvocationCount: 1, totalTokens: 10, openRouterCostUsd: 0, repositoryOperationCount: 1, activeMutationCount: 0 },
      createdAt: '2026-08-04T12:05:00.000Z',
    }],
    agentActions: [{
      id: '77777777-7777-4777-8777-777777777777', projectId, iterationId, role: 'test', planId: null,
      position: 0, kind: 'test', summary: 'Acceptance suite completed.', status: 'completed', blocking: true,
      dependencyActionIds: [], input: {}, output: { passed: true }, error: null, correlationId: 'test:acceptance',
      createdAt: '2026-08-04T12:05:00.000Z', updatedAt: '2026-08-04T12:06:00.000Z',
      startedAt: '2026-08-04T12:05:00.000Z', completedAt: '2026-08-04T12:06:00.000Z',
    }],
    modelInvocations: [{
      id: '88888888-8888-4888-8888-888888888888', projectId, iterationId, role: 'builder', actionId: null,
      provider: 'ollama', model: 'qwen', purpose: 'generate', status: 'succeeded', externalRequestId: null,
      inputTokens: 5, outputTokens: 5, cachedTokens: 0, totalTokens: 10, costUsd: 0,
      requestMetadata: {}, responseMetadata: {}, error: null, correlationId: 'model:builder',
      createdAt: '2026-08-04T12:01:00.000Z', startedAt: '2026-08-04T12:01:30.000Z', completedAt: '2026-08-04T12:02:30.000Z',
    }],
    repositoryOperations: [{
      id: '99999999-9999-4999-8999-999999999999', projectId, iterationId, role: 'builder', actionId: null,
      lifecycleRecordId: null, type: 'commit', status: 'completed', mutating: true, repositoryUrl: null,
      branchName: 'iteration-1', paths: ['apps/web/src/App.tsx'], expectedBaseRevision: null,
      resultingRevision: 'a'.repeat(40), externalId: null, summary: 'Committed the typed event projection.',
      metadata: {}, correlationId: 'repository:commit', createdAt: '2026-08-04T12:02:00.000Z',
      startedAt: '2026-08-04T12:02:00.000Z', completedAt: '2026-08-04T12:03:00.000Z',
    }],
  };
}

describe('typed organism event projection', () => {
  it('projects durable records with stable identity, ordering, and explicit event types', () => {
    const source = detail();
    const events = projectOrganismEvents(source);

    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'agent.state.changed',
      'agent.activity.started',
      'agent.activity.completed',
      'message.sent',
      'artifact.revised',
      'finding.opened',
      'iteration.review.proposed',
      'repository.revision.changed',
      'test.completed',
      'preview.deployed',
    ]));
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.map((event) => event.eventId)).toEqual(projectOrganismEvents(source).map((event) => event.eventId));
    expect(events.every((event) => organismEventSchema.safeParse(event).success)).toBe(true);

    const message = events.find((event) => event.type === 'message.sent')!;
    expect(interactionFromOrganismEvent(message, source)).toMatchObject({
      id: 'message-1', from: 'builder', to: ['test'], kind: 'handoff', status: 'in_progress', live: true,
    });
    const repository = events.find((event) => event.type === 'repository.revision.changed')!;
    expect(interactionFromOrganismEvent(repository, source)?.dimensions).toEqual(['repository']);
  });
});
