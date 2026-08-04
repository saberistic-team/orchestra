import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentOrder, AgentResult, AuthorityGrant } from '@orchestra/contracts';
import {
  AgentRuntimeError,
  bootstrapAgentState,
  enqueueMessage,
  getAgentStatus,
  pauseAgent,
  recordResult,
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
});

describe('agent runtime orders and controls', () => {
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
      activeOrderCount: 0,
      resultCount: 1,
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
});
