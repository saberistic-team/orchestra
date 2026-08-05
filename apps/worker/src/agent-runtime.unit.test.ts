import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentOrder, AgentResult, AuthorityGrant } from '@orchestra/contracts';
import {
  AgentRuntimeError,
  beginAgentActivity,
  beginAgentCommunication,
  blockAgentActivity,
  bootstrapAgentState,
  completeAgentActivity,
  completeAgentCommunication,
  dequeueNextMessage,
  enqueueMessage,
  getAgentStatus,
  pauseAgent,
  recordResult,
  resolvePendingQuestion,
  resumeAgent,
  selectNextMessage,
  shouldContinueAsNew,
  startOrder,
  submitOrder,
} from './agent-runtime.js';

const address = {
  projectId: 'project-1',
  role: 'builder',
  workflowId: 'project/project-1/agent/builder',
} as const;

function authority(
  permittedActions: string[],
  permittedTargets: AuthorityGrant['permittedTargets'] = ['builder'],
  scopeRefs: string[] = ['work-package-1', 'apps/worker'],
): AuthorityGrant {
  return {
    grantId: `grant-${permittedActions.join('-')}`,
    issuerRole: 'planner',
    level: 'WORK_PACKAGE',
    permittedActions,
    permittedTargets,
    scopeRefs,
    mayDelegate: false,
  };
}

function message(
  messageId: string,
  priority: AgentMessage['priority'] = 'NORMAL',
  graphVersion = 3,
): AgentMessage {
  return {
    schemaVersion: '1.0',
    messageId,
    idempotencyKey: `idempotency-${messageId}`,
    projectId: 'project-1',
    correlationId: 'correlation-1',
    sender: {
      projectId: 'project-1',
      role: 'planner',
      workflowId: 'project/project-1/agent/planner',
    },
    recipients: [address],
    kind: 'STATUS',
    name: 'order.progressed',
    priority,
    graphVersion,
    projectStateVersion: 7,
    senderStateVersion: 2,
    authority: authority(['STATUS']),
    payload: { summary: messageId },
    acknowledgementRequired: false,
    createdAt: '2026-08-03T12:00:00.000Z',
  };
}

function order(overrides: Partial<AgentOrder> = {}): AgentOrder {
  return {
    orderId: 'order-1',
    type: 'IMPLEMENT',
    objective: 'Implement the bounded work package.',
    scope: {
      included: ['work-package-1'],
      excluded: [],
      affectedComponents: ['apps/worker'],
      workPackageRefs: ['work-package-1'],
    },
    expectedOutputs: [],
    acceptanceCriteria: [],
    requiredEvidence: [],
    dependencies: [],
    constraints: {},
    loopPolicy: {
      mode: 'IMPLEMENTATION',
      reasoningDepth: 'STANDARD',
      evidenceStrength: 'STANDARD',
      requiredCollaborators: [],
      optionalCollaborators: [],
      maxParallelActions: 1,
      maxIterations: 3,
      maxRemediationRounds: 2,
      requiredApprovals: [],
      requiredGates: [],
      onMissingInformation: 'ASK',
      onConflict: 'RECONCILE',
      onFailure: 'REMEDIATE',
      interruptionPolicy: 'SAFE_BOUNDARY',
    },
    authority: authority(['IMPLEMENT']),
    sourceArtifactVersions: [],
    priority: 'NORMAL',
    ...overrides,
  };
}

function completedResult(stateVersion: number): AgentResult {
  return {
    orderId: 'order-1',
    role: 'builder',
    status: 'COMPLETED',
    summary: 'Implementation completed with the required evidence.',
    outputs: [],
    evidence: [],
    findings: [],
    decisions: [],
    assumptionsCreated: [],
    assumptionsInvalidated: [],
    unresolvedQuestions: [],
    limitations: [],
    recommendedActions: [],
    sourceVersions: [],
    stateVersion,
  };
}

function state() {
  return bootstrapAgentState({ address, graphVersion: 3, projectStateVersion: 7 });
}

describe('agent runtime mailbox', () => {
  it('suppresses a duplicate message without changing state or version', () => {
    const once = enqueueMessage(state(), message('message-1'));
    const duplicate = enqueueMessage(once, message('message-1'));

    expect(duplicate).toBe(once);
    expect(duplicate.mailbox).toHaveLength(1);
    expect(duplicate.stateVersion).toBe(1);
  });

  it('rejects a message from a stale graph version', () => {
    expect(() => enqueueMessage(state(), message('stale', 'NORMAL', 2)))
      .toThrowError(expect.objectContaining<Partial<AgentRuntimeError>>({ code: 'STALE_GRAPH_VERSION' }));
  });

  it('selects the highest priority and preserves FIFO order for ties', () => {
    const queued = [
      message('low', 'LOW'),
      message('critical-first', 'CRITICAL'),
      message('critical-second', 'CRITICAL'),
      message('high', 'HIGH'),
    ].reduce(enqueueMessage, state());

    expect(selectNextMessage(queued)?.messageId).toBe('critical-first');
  });

  it('records a one-way communication and restores a pre-existing blocker after receipt', () => {
    const handoff = {
      ...message('handoff'),
      kind: 'EVIDENCE' as const,
      name: 'artifact.handoff',
      acknowledgementRequired: true,
      payload: { summary: 'Build submission was handed to builder.', iterationNumber: 7 },
    };
    const blocked = blockAgentActivity(state(), 'Waiting for a required repository revision.');
    const queued = enqueueMessage(blocked, handoff);
    const dequeued = dequeueNextMessage(queued);
    const receipt = beginAgentCommunication(
      dequeued.state,
      dequeued.message!,
      7,
      'handoff',
      handoff.payload.summary,
    );

    expect(getAgentStatus(receipt.state)).toMatchObject({
      status: 'ACTIVE', state: 'communicating',
      activity: { type: 'artifact.handoff', summary: handoff.payload.summary },
    });
    expect(receipt.state.interactions).toContainEqual(expect.objectContaining({
      id: 'received:handoff:builder',
      from: 'planner', to: ['builder'], kind: 'handoff', status: 'acknowledged', live: true,
    }));

    const restored = completeAgentCommunication(
      receipt.state,
      receipt.baseline,
      receipt.interactionId,
      'Handoff received.',
    );
    expect(getAgentStatus(restored)).toMatchObject({
      status: 'BLOCKED', state: 'blocked', blockerCount: 1,
    });
    expect(restored.interactions).toContainEqual(expect.objectContaining({
      id: 'received:handoff:builder', status: 'completed', live: false,
    }));
  });
});

describe('agent runtime orders and controls', () => {
  it('projects precise organizational activity without implying an idle actor disappeared', () => {
    const working = beginAgentActivity(state(), {
      type: 'implementation',
      summary: 'Implementing the bounded work package.',
      state: 'working',
    });
    const monitoring = completeAgentActivity(working, 'Monitoring the handed-off revision.');
    const blocked = blockAgentActivity(monitoring, 'Waiting for a required repository revision.');

    expect(getAgentStatus(working)).toMatchObject({
      status: 'ACTIVE',
      state: 'working',
      activity: { type: 'implementation', summary: 'Implementing the bounded work package.' },
    });
    expect(getAgentStatus(monitoring)).toMatchObject({
      status: 'IDLE',
      state: 'monitoring',
      activity: { type: 'obligation_monitoring' },
    });
    expect(getAgentStatus(blocked)).toMatchObject({
      status: 'BLOCKED',
      state: 'blocked',
      blockerCount: 1,
    });
  });

  it('rejects an order whose grant does not authorize this target', () => {
    const unauthorized = order({ authority: authority(['IMPLEMENT'], ['reviewer']) });

    expect(() => submitOrder(state(), unauthorized))
      .toThrowError(expect.objectContaining<Partial<AgentRuntimeError>>({ code: 'UNAUTHORIZED_TARGET' }));
  });

  it('pauses and resumes while restoring the active loop mode', () => {
    const submitted = submitOrder(state(), order());
    const running = startOrder(submitted, 'order-1');
    const controlAuthority = authority(['PAUSE', 'RESUME']);
    const paused = pauseAgent(running, controlAuthority);
    const resumed = resumeAgent(paused, controlAuthority);

    expect(paused).toMatchObject({ mode: 'PAUSED', status: 'PAUSED' });
    expect(resumed).toMatchObject({ mode: 'IMPLEMENTATION', status: 'ACTIVE' });
    expect(resumed.stateVersion).toBe(running.stateVersion + 2);
  });

  it('records a completion and returns an agent with no remaining work to idle', () => {
    const running = startOrder(submitOrder(state(), order()), 'order-1');
    const completed = recordResult(running, completedResult(running.stateVersion));

    expect(completed.orders[0]).toMatchObject({ status: 'COMPLETED' });
    expect(completed.results).toHaveLength(1);
    expect(getAgentStatus(completed)).toMatchObject({
      mode: 'DORMANT',
      status: 'IDLE',
      state: 'monitoring',
      activeOrderCount: 0,
      resultCount: 1,
    });
  });

  it('keeps a partial order visibly waiting until its durable question is resolved', () => {
    const running = startOrder(submitOrder(state(), order()), 'order-1');
    const waiting = recordResult(running, {
      ...completedResult(running.stateVersion),
      status: 'PARTIAL',
      summary: 'A product decision is required.',
      unresolvedQuestions: [{
        questionId: 'question-1',
        question: 'Which persistence strategy should be used?',
        askedBy: address,
        targetRoles: ['manager'],
        status: 'OPEN',
        contextRefs: ['work-package-1'],
        createdAt: '2026-08-04T12:00:00.000Z',
      }],
    });

    expect(getAgentStatus(waiting)).toMatchObject({
      status: 'IDLE', state: 'waiting_on_human', pendingQuestionCount: 1,
    });
    const resolved = resolvePendingQuestion(waiting, 'question-1');
    expect(getAgentStatus(resolved)).toMatchObject({
      status: 'IDLE', state: 'monitoring', pendingQuestionCount: 0,
    });
  });

  it('requests continuation exactly at the configured event threshold', () => {
    const initial = bootstrapAgentState({
      address,
      graphVersion: 3,
      eventCount: 1,
      continueAsNewEventThreshold: 2,
    });
    const transitioned = enqueueMessage(initial, message('threshold'));

    expect(shouldContinueAsNew(initial)).toBe(false);
    expect(shouldContinueAsNew(transitioned)).toBe(true);
  });

  it('does not continue as new while an order is active', () => {
    const initial = bootstrapAgentState({
      address,
      graphVersion: 3,
      eventCount: 2,
      continueAsNewEventThreshold: 2,
    });
    const running = startOrder(submitOrder(initial, order()), 'order-1');

    expect(shouldContinueAsNew(running)).toBe(false);
  });
});
