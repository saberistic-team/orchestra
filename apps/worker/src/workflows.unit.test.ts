import { describe, expect, it } from 'vitest';
import { agentOrderSchema, dynamicHumanDecisionRequestSchema, iterationReviewProposalSchema, type AgentArtifactReference, type AgentMessage, type AgentRole, type AgentWorkflowInput, type AgentWorkflowResult, type IterationReviewProposal, type Project, type ProjectIteration } from '@orchestra/contracts';
import {
  AgentHumanDecisionCoordinator,
  acceptIterationReviewSubmission,
  agentArtifactContextPatterns,
  agentArtifactPersistenceOperationKey,
  agentHumanDecisionOperationKey,
  agentUserFlowMediaOperationKey,
  agentOrderContext,
  assessReactiveContinuationSafety,
  beginReactiveIterationRound,
  boundedProjectWorkflowContinuation,
  createReviewCheckpoint,
  continuationRoundRoles,
  defersCompletionUntilGateReadiness,
  evaluateGateReadiness,
  invalidateReviewCandidateForHumanGuidance,
  iterationReviewProgressFingerprint,
  isAgentExecutionCommandMessage,
  mergeAgentArtifactContext,
  mergeHumanGuidance,
  parentVerificationBlockedLedgerProjection,
  reactiveIterationRoles,
  reactiveContinuationSafetyDecision,
  requiredHumanDecisionIds,
  reviewAdvancesIteration,
  reviewProposalRequiresWakeup,
  reviewProposalWorkflowAction,
  runtimeOrderForExecution,
  targetedArtifactFeedbackOwnerRoles,
  targetedReviewReactivationRoles,
} from './workflows.js';
import { PREVIEW_CONTRACT_VERSION, PREVIEW_RUNTIME_CONTRACT, deliveryAgentGraph, type PreviewDeploymentResult } from '@orchestra/contracts';

const now = '2026-08-03T12:00:00.000Z';
const project: Project = {
  id: 'b67a2fd5-e829-40dc-a6f5-d15e4758515d',
  name: 'Orchestra',
  intent: 'Help a person build software from their intentions.',
  audience: 'Non-technical founders',
  success: 'A reviewed first release is produced safely.',
  constraints: [],
  status: 'building',
  currentIteration: 2,
  previewUrl: null,
  repositoryUrl: 'https://forgejo.example/orchestra/project',
  repositoryOwner: 'orchestra',
  repositoryName: 'project',
  createdAt: now,
  updatedAt: now,
};
const iteration: ProjectIteration = {
  id: 'c67a2fd5-e829-40dc-a6f5-d15e4758515d',
  projectId: project.id,
  number: 2,
  objective: 'Revise the walking skeleton.',
  status: 'changes_requested',
  startedAt: now,
  completedAt: null,
  issueNumber: 8,
  branchName: 'iteration-2-agents',
  pullRequestNumber: 9,
  pullRequestUrl: 'https://forgejo.example/orchestra/project/pulls/9',
};
const previewRevision = '0123456789abcdef0123456789abcdef01234567';
const previewImageDigest = `sha256:${'a'.repeat(64)}`;
const preview: PreviewDeploymentResult = {
  contractVersion: PREVIEW_CONTRACT_VERSION,
  title: 'Iteration 2 preview',
  publicUrl: 'http://localhost:4173/previews/iteration-2',
  internalUrl: 'http://preview-runtime:8080/',
  revision: previewRevision,
  imageDigest: previewImageDigest,
  expiresAt: '2026-08-03T14:00:00.000Z',
  source: 'managed',
  runtime: PREVIEW_RUNTIME_CONTRACT,
};

function continuationProposal(overrides: Partial<IterationReviewProposal> = {}): IterationReviewProposal {
  return iterationReviewProposalSchema.parse({
    id: 'review-proposal-2',
    projectId: project.id,
    iterationId: iteration.id,
    iterationNumber: iteration.number,
    type: 'iteration_review_proposal',
    proposalVersion: 1,
    status: 'proposed',
    objectiveStatus: 'satisfied_with_known_gaps',
    includedRevision: previewRevision,
    completedOutcomes: ['Builder produced Build submission v1'],
    openFindings: [],
    agentPositions: Object.fromEntries(deliveryAgentGraph.map((definition) => [
      definition.role,
      definition.role === 'builder' ? 'not_ready' : 'ready',
    ])),
    gateStatus: 'pass',
    gateRationale: 'The immutable revision passed deterministic checks.',
    managerRationale: 'Builder remains not ready.',
    recommendation: 'continue_iteration',
    knownLimitations: ['Builder remains not ready.'],
    budgetSnapshot: {
      modelInvocationCount: 1,
      totalTokens: 1_000,
      openRouterCostUsd: 0.1,
      repositoryOperationCount: 1,
      activeMutationCount: 0,
    },
    createdAt: now,
    ...overrides,
  });
}

describe('reactive organism activation', () => {
  it('carries the durable coordinator boundary while bounding model context', () => {
    const nextRoundRoles: AgentRole[] = ['builder', 'test', 'gate'];
    const continuation = boundedProjectWorkflowContinuation({
      iterationNumber: 3,
      executionRound: 8,
      nextRoundRoles,
      reactiveIterationSafety: {
        iterationNumber: 3,
        executionRounds: 8,
        noProgressRounds: 2,
        lastProgressFingerprint: 'same-candidate',
      },
      reviewSequence: 5,
      resumeVersion: 11,
      context: `discarded-${'x'.repeat(24_000)}`,
      state: 'reviewing',
      durableHumanGuidanceEnabled: true,
      persistentActors: true,
      actorMailboxDelivery: true,
      humanGuidanceActorMailbox: true,
      splitAgentTaskQueues: true,
    });

    expect(continuation).toMatchObject({
      iterationNumber: 3,
      executionRound: 8,
      nextRoundRoles: ['builder', 'test', 'gate'],
      reviewSequence: 5,
      resumeVersion: 11,
      state: 'reviewing',
      durableHumanGuidanceEnabled: true,
      persistentActors: true,
      actorMailboxDelivery: true,
      humanGuidanceActorMailbox: true,
      splitAgentTaskQueues: true,
    });
    expect(continuation.context).toHaveLength(24_000);
    expect(continuation.context).not.toContain('discarded-');
    expect(continuation.nextRoundRoles).not.toBe(nextRoundRoles);
  });

  it('merges guidance accepted during continuation drain into the next activation set', () => {
    expect(continuationRoundRoles(['test', 'reviewer', 'gate'], ['builder'])).toEqual([
      'builder',
      'test',
      'reviewer',
      'gate',
    ]);
    expect(continuationRoundRoles(undefined, [])).toBeUndefined();
  });

  it('reactivates only an affected role and its downstream evidence path', () => {
    expect(reactiveIterationRoles(['builder'])).toEqual(['builder', 'test', 'reviewer', 'gate']);
    expect(reactiveIterationRoles(['security'])).toEqual(['security', 'planner', 'builder', 'test', 'reviewer', 'gate']);
  });

  it('uses the full mandatory organism when no durable owner can be identified', () => {
    expect(reactiveIterationRoles([])).toEqual(
      deliveryAgentGraph
        .filter((definition) => definition.activation !== 'authorized_release')
        .map((definition) => definition.role),
    );
  });

  it('keeps targeted review feedback on its owner path unless broad direction is explicit', () => {
    expect(targetedReviewReactivationRoles('', ['builder'], [])).toEqual(['builder', 'test', 'reviewer', 'gate']);
    expect(targetedReviewReactivationRoles('', [], ['security'])).toEqual(['security', 'planner', 'builder', 'test', 'reviewer', 'gate']);
    expect(targetedReviewReactivationRoles('Reconsider the entire increment.', ['builder'], [])).toEqual(
      deliveryAgentGraph
        .filter((definition) => definition.activation !== 'authorized_release')
        .map((definition) => definition.role),
    );
    expect(targetedArtifactFeedbackOwnerRoles(
      [
        { artifactId: 'security-artifact', feedback: 'Revisit session expiry.' },
        { artifactId: 'builder-artifact', feedback: '' },
      ],
      new Map([
        ['security-artifact', 'security' as const],
        ['builder-artifact', 'builder' as const],
        ['unrelated-artifact', 'architecture' as const],
      ]),
    )).toEqual(['security']);
  });

  it('continues a Manager-directed iteration without treating it as a human wait', () => {
    expect(reviewProposalWorkflowAction('continue_iteration')).toBe('continue_autonomously');
    expect(reviewProposalRequiresWakeup('continue_iteration', true)).toBe(false);
    expect(reviewProposalRequiresWakeup('continue_iteration', false)).toBe(true);
    expect(reviewProposalWorkflowAction('request_human_decision')).toBe('wait_for_human');
    expect(reviewProposalRequiresWakeup('request_human_decision', true)).toBe(true);
    expect(reviewProposalWorkflowAction('reduce_scope')).toBe('wait_for_human');
    expect(reviewProposalRequiresWakeup('reduce_scope', true)).toBe(true);
    expect(reviewProposalWorkflowAction('send_for_human_review')).toBe('open_review');
  });

  it('counts outer execution rounds cumulatively and resets at an iteration boundary', () => {
    const first = beginReactiveIterationRound(undefined, 2);
    const second = beginReactiveIterationRound(first, 2);

    expect(second).toMatchObject({ iterationNumber: 2, executionRounds: 2, noProgressRounds: 0 });
    expect(beginReactiveIterationRound(second, 3)).toEqual({
      iterationNumber: 3,
      executionRounds: 1,
      noProgressRounds: 0,
    });
  });

  it('exhausts after repeated readiness-equivalent continuation rounds', () => {
    const limits = { maxExecutionRounds: 20, maxNoProgressRounds: 2 };
    const firstProposal = continuationProposal();
    const first = assessReactiveContinuationSafety(
      beginReactiveIterationRound(undefined, 2),
      firstProposal,
      limits,
    );
    const secondProposal = continuationProposal({
      budgetSnapshot: {
        ...firstProposal.budgetSnapshot,
        modelInvocationCount: 2,
        totalTokens: 2_000,
        repositoryOperationCount: 2,
      },
    });
    const second = assessReactiveContinuationSafety(
      beginReactiveIterationRound(first.state, 2),
      secondProposal,
      limits,
    );
    const third = assessReactiveContinuationSafety(
      beginReactiveIterationRound(second.state, 2),
      continuationProposal({
        budgetSnapshot: {
          ...secondProposal.budgetSnapshot,
          modelInvocationCount: 3,
          totalTokens: 3_000,
          repositoryOperationCount: 3,
        },
      }),
      limits,
    );

    expect(iterationReviewProgressFingerprint(firstProposal)).toBe(
      iterationReviewProgressFingerprint(secondProposal),
    );
    expect(second).toMatchObject({ exhausted: false, state: { noProgressRounds: 1 } });
    expect(third).toMatchObject({
      exhausted: true,
      reason: 'no_progress_limit',
      state: { noProgressRounds: 2, executionRounds: 3 },
    });
  });

  it('resets no-progress tracking when durable readiness evidence changes', () => {
    const limits = { maxExecutionRounds: 20, maxNoProgressRounds: 2 };
    const proposal = continuationProposal();
    const first = assessReactiveContinuationSafety(
      beginReactiveIterationRound(undefined, 2),
      proposal,
      limits,
    );
    const unchanged = assessReactiveContinuationSafety(
      beginReactiveIterationRound(first.state, 2),
      proposal,
      limits,
    );
    const progressed = assessReactiveContinuationSafety(
      beginReactiveIterationRound(unchanged.state, 2),
      continuationProposal({
        includedRevision: 'b'.repeat(40),
        completedOutcomes: [...proposal.completedOutcomes, 'Builder completed the blocking correction'],
      }),
      limits,
    );

    expect(unchanged.state.noProgressRounds).toBe(1);
    expect(progressed).toMatchObject({ exhausted: false, state: { noProgressRounds: 0 } });
  });

  it('stops before an execution round beyond the cumulative iteration limit', () => {
    let state = beginReactiveIterationRound(undefined, 2);
    for (let round = 2; round <= 8; round += 1) {
      state = beginReactiveIterationRound(state, 2);
    }
    const assessment = assessReactiveContinuationSafety(
      state,
      continuationProposal(),
      { maxExecutionRounds: 8, maxNoProgressRounds: 20 },
    );

    expect(assessment).toMatchObject({
      exhausted: true,
      reason: 'execution_round_limit',
      state: { executionRounds: 8 },
    });
  });

  it('turns safety exhaustion into a concrete Manager decision with a reduce-scope path', () => {
    const proposal = continuationProposal();
    const request = reactiveContinuationSafetyDecision(
      {
        iterationNumber: 2,
        executionRounds: 8,
        noProgressRounds: 2,
        lastProgressFingerprint: iterationReviewProgressFingerprint(proposal),
      },
      'execution_round_limit',
      proposal,
    );

    expect(dynamicHumanDecisionRequestSchema.parse(request)).toEqual(request);
    expect(request.allowAgentDecide).toBe(false);
    expect(request.options.map((option) => option.value)).toEqual([
      'continue_bounded_round',
      'reduce_scope',
    ]);
  });
});
const artifact = (id: string, content: string): AgentArtifactReference => ({
  id,
  type: 'requirements-baseline',
  name: 'Requirements baseline',
  version: 1,
  mimeType: 'text/markdown',
  producedBy: 'requirements',
  contentAddress: `orchestra-artifact://postgres/${project.id}/${id}?version=1`,
  contentHash: `sha256:${'a'.repeat(64)}`,
  byteLength: Buffer.byteLength(content, 'utf8'),
  repositoryPath: `artifacts/${id}.md`,
  repositoryUrl: `https://forgejo.example/artifacts/${id}`,
});

describe('human decision coordination', () => {
  it('cannot lose a question-answer wakeup that arrives while the durable answer check is outstanding', () => {
    const coordinator = new AgentHumanDecisionCoordinator();
    const scope = { role: 'builder' as const, orderId: 'builder-order-1' };
    coordinator.registerQuestions(['question-1'], scope);

    // waitForAgentQuestions captures this token before starting its Activity.
    const capturedBeforeActivity = coordinator.captureQuestionWait();
    coordinator.noteQuestionInput('question-1');
    coordinator.markQuestionAnswered('question-1');

    expect(coordinator.shouldRecheckQuestions(['question-1'], capturedBeforeActivity)).toBe(true);
    expect(coordinator.areQuestionsLocallyAnswered(['question-1'])).toBe(true);
  });

  it('rechecks when an answer was accepted just before the waiter captured its version', () => {
    const coordinator = new AgentHumanDecisionCoordinator();
    const scope = { role: 'builder' as const, orderId: 'builder-order-early-answer' };
    coordinator.registerQuestions(['question-early'], scope);
    coordinator.noteQuestionInput('question-early');

    const capturedAfterSignal = coordinator.captureQuestionWait();

    expect(coordinator.shouldRecheckQuestions(['question-early'], capturedAfterSignal)).toBe(true);
    coordinator.beginQuestionPersistence('question-early');
    const capturedDuringPersistence = coordinator.captureQuestionWait();
    expect(coordinator.shouldRecheckQuestions(['question-early'], capturedDuringPersistence)).toBe(false);
    coordinator.markQuestionAnswered('question-early');
    expect(coordinator.shouldRecheckQuestions(['question-early'], capturedDuringPersistence)).toBe(true);
  });

  it('releases only the role/order that owns an answered question', () => {
    const coordinator = new AgentHumanDecisionCoordinator();
    const builder = { role: 'builder' as const, orderId: 'builder-order-1' };
    const test = { role: 'test' as const, orderId: 'test-order-1' };
    coordinator.registerQuestions(['builder-question'], builder);
    coordinator.registerQuestions(['test-question'], test);
    const builderToken = coordinator.captureRetry(builder);
    const testToken = coordinator.captureRetry(test);

    coordinator.noteQuestionInput('builder-question');

    expect(coordinator.shouldRetry(builder, builderToken)).toBe(true);
    expect(coordinator.shouldRetry(test, testToken)).toBe(false);
  });

  it('still supports an explicit global resume without conflating it with an answer', () => {
    const coordinator = new AgentHumanDecisionCoordinator();
    const builder = { role: 'builder' as const, orderId: 'builder-order-1' };
    const test = { role: 'test' as const, orderId: 'test-order-1' };
    const builderToken = coordinator.captureRetry(builder);
    const testToken = coordinator.captureRetry(test);

    coordinator.requestQuestionRecheck();
    expect(coordinator.shouldRetry(builder, builderToken)).toBe(false);
    expect(coordinator.shouldRetry(test, testToken)).toBe(false);

    coordinator.resume();

    expect(coordinator.shouldRetry(builder, builderToken)).toBe(true);
    expect(coordinator.shouldRetry(test, testToken)).toBe(true);
  });
});

describe('agent order context', () => {
  it('keeps artifact and human-decision side effects stable across retry workflow ids', () => {
    const input: AgentWorkflowInput = {
      project,
      iteration,
      role: 'builder',
      artifactType: 'build-submission',
      artifactName: 'Build submission',
      context: 'Implement the bounded iteration.',
      executionOperationId: 'project-1:iteration-2:run-3:builder',
      artifactOperationId: 'project-1:iteration-2:run-3:builder:artifact-revision:0',
    };

    expect(agentArtifactPersistenceOperationKey(input, 'model-attempt-1')).toBe(
      agentArtifactPersistenceOperationKey(input, 'model-attempt-2'),
    );
    expect(agentHumanDecisionOperationKey(input, 'model-attempt-1', 'product.export_format')).toBe(
      agentHumanDecisionOperationKey(input, 'model-attempt-2', 'product.export_format'),
    );
    expect(agentUserFlowMediaOperationKey(input, 'model-attempt-1')).toBe(
      agentUserFlowMediaOperationKey(input, 'model-attempt-2'),
    );
    const corrected = {
      ...input,
      artifactOperationId: 'project-1:iteration-2:run-3:builder:artifact-revision:1',
    };
    expect(agentArtifactPersistenceOperationKey(corrected, 'model-attempt-3')).not.toBe(
      agentArtifactPersistenceOperationKey(input, 'model-attempt-1'),
    );
    expect(agentHumanDecisionOperationKey(corrected, 'model-attempt-3', 'product.export_format')).toBe(
      agentHumanDecisionOperationKey(input, 'model-attempt-1', 'product.export_format'),
    );
  });

  it('routes only an exact order.submit command to executable agent work', () => {
    const input: AgentWorkflowInput = {
      project,
      iteration,
      role: 'builder',
      artifactType: 'build-submission',
      artifactName: 'Build submission',
      context: 'Implement the bounded iteration.',
    };
    const order = runtimeOrderForExecution(input, 'builder-order-mailbox');
    const command: AgentMessage = {
      schemaVersion: '1.0',
      messageId: 'builder-order-mailbox',
      idempotencyKey: 'builder-order-mailbox',
      projectId: project.id,
      iterationId: iteration.id,
      correlationId: 'iteration:2',
      sender: { projectId: project.id, role: 'manager', workflowId: `project/${project.id}/agent/manager` },
      recipients: [{ projectId: project.id, role: 'builder', workflowId: `project/${project.id}/agent/builder` }],
      kind: 'COMMAND',
      name: 'order.submit',
      priority: 'NORMAL',
      graphVersion: 1,
      projectStateVersion: 2,
      senderStateVersion: 2,
      authority: order.authority,
      payload: { orderId: order.orderId, order, input, replyWorkflowId: `project/${project.id}` },
      acknowledgementRequired: true,
      createdAt: now,
    };

    expect(isAgentExecutionCommandMessage(command)).toBe(true);
    expect(isAgentExecutionCommandMessage({ ...command, kind: 'EVIDENCE', name: 'artifact.handoff' })).toBe(false);
    expect(isAgentExecutionCommandMessage({ ...command, name: 'order.progressed' })).toBe(false);
  });

  it('builds a strict, authority-bounded order for a persistent role actor', () => {
    const input: AgentWorkflowInput = {
      project,
      iteration,
      role: 'builder',
      artifactType: 'build-submission',
      artifactName: 'Build submission',
      context: 'Implement the approved iteration plan.',
      inputArtifacts: [artifact('plan', 'Approved implementation plan')],
      supervisedBy: ['architecture', 'security'],
      handsOffTo: ['test'],
      executionLimits: { maxTokens: 12_000, maxPlanningRounds: 7 },
    };

    const order = runtimeOrderForExecution(input, 'builder-order-1');

    expect(agentOrderSchema.parse(order)).toEqual(order);
    expect(order).toMatchObject({
      orderId: 'builder-order-1',
      type: 'IMPLEMENT',
      constraints: {
        allowedTools: [
          'model.generate_artifact',
          'model.review_artifact',
          'model.revise_artifact',
        ],
        tokenBudget: 12_000,
      },
      loopPolicy: {
        mode: 'IMPLEMENTATION',
        maxIterations: 7,
        requiredCollaborators: ['architecture', 'security'],
      },
      authority: {
        issuerRole: 'manager',
        permittedActions: ['IMPLEMENT', 'EXECUTE_BOUNDED_STEP'],
        permittedTargets: ['builder'],
        mayDelegate: false,
      },
    });
  });

  it('loads a role\'s previous outputs in addition to its declared inputs', () => {
    const builder = deliveryAgentGraph.find((step) => step.role === 'builder')!;

    expect(agentArtifactContextPatterns(builder)).toEqual(expect.arrayContaining([
      'build-submission', 'source-file:*', 'iteration-plan', 'packaging-plan', 'packaging-evidence',
    ]));
  });

  it('keeps current artifacts ahead of prior versions and removes duplicate identities', () => {
    const merged = mergeAgentArtifactContext(
      [artifact('current', 'current'), artifact('shared', 'current shared')],
      [artifact('prior', 'prior'), artifact('shared', 'old shared')],
    );

    expect(merged.map((entry) => entry.id)).toEqual(['current', 'shared', 'prior']);
    expect(merged.find((entry) => entry.id === 'shared')?.byteLength).toBe(Buffer.byteLength('current shared', 'utf8'));
  });

  it('always includes repository coordinates and role-specific human direction', () => {
    const context = agentOrderContext('Base intent', project, iteration, 'builder', [artifact('prior', 'Prior accepted requirements')], [
      { key: 'all', kind: 'overall_direction', summary: 'Keep the revision narrow.' },
      { key: 'builder', kind: 'agent_comment', role: 'builder', summary: 'Preserve the existing API.' },
      { key: 'ux', kind: 'agent_comment', role: 'ux', summary: 'Change the color palette.' },
    ]);

    expect(context).toContain('https://forgejo.example/orchestra/project');
    expect(context).toContain('Iteration branch: iteration-2-agents');
    expect(context).toContain(`orchestra-artifact://postgres/${project.id}/prior?version=1`);
    expect(context).toContain('Keep the revision narrow.');
    expect(context).toContain('Preserve the existing API.');
    expect(context).not.toContain('Change the color palette.');
  });

  it('merges durable project decisions and feedback without duplicating replayed entries', () => {
    const merged = mergeHumanGuidance(
      [{ key: 'decision:export.format', kind: 'question_answer', summary: 'Old answer' }],
      [
        { key: 'decision:export.format', kind: 'question_answer', summary: 'Latest durable answer' },
        { key: 'comment:builder', kind: 'agent_comment', role: 'builder', summary: 'Keep it small.' },
      ],
    );

    expect(merged).toEqual([
      { key: 'decision:export.format', kind: 'question_answer', summary: 'Latest durable answer' },
      { key: 'comment:builder', kind: 'agent_comment', role: 'builder', summary: 'Keep it small.' },
    ]);
    expect(requiredHumanDecisionIds(merged)).toEqual(['decision:export.format']);
    expect(requiredHumanDecisionIds(merged, 'builder')).toEqual([
      'decision:export.format',
      'comment:builder',
    ]);
  });
});

describe('iteration review advancement', () => {
  it('keeps Gate incomplete until parent readiness and blocks without satisfying its artifacts', () => {
    const gateResult: AgentWorkflowResult = {
      draft: {
        type: 'gate-decision',
        name: 'Gate decision',
        content: 'The model proposed a pass before deterministic verification.',
        mimeType: 'text/markdown',
        producedBy: 'gate',
        model: 'test-model',
        gateDecision: { status: 'pass', rationale: 'Model evidence looked complete.', missingEvidence: [] },
      },
      artifacts: [{
        id: 'gate-artifact-1',
        projectId: project.id,
        iterationId: iteration.id,
        type: 'gate-decision',
        name: 'Gate decision',
        content: 'Candidate evidence',
        mimeType: 'text/markdown',
        producedBy: 'gate',
        model: 'test-model',
        modelProvider: 'ollama',
        version: 1,
        status: 'ready_for_review',
        repositoryPath: null,
        repositoryUrl: null,
        createdAt: now,
        reviewedAt: null,
      }],
    };

    expect(defersCompletionUntilGateReadiness('builder', true)).toBe(false);
    expect(defersCompletionUntilGateReadiness('gate', false)).toBe(false);
    expect(defersCompletionUntilGateReadiness('gate', true)).toBe(true);
    expect(parentVerificationBlockedLedgerProjection(
      gateResult,
      'Required upstream artifact is absent: review-decision',
    )).toEqual({
      status: 'blocked',
      trace: undefined,
      artifactIds: [],
      failureReason: 'Required upstream artifact is absent: review-decision',
    });
  });

  it('requires a structured Gate pass and every declared upstream evidence artifact', () => {
    const gateResult: AgentWorkflowResult = {
      draft: {
        type: 'gate-decision',
        name: 'Gate decision',
        content: 'All required evidence is traceable.',
        mimeType: 'text/markdown',
        producedBy: 'gate',
        model: 'test-model',
        gateDecision: { status: 'pass', rationale: 'Evidence is complete.', missingEvidence: [] },
      },
      artifacts: [],
    };
    const inputs = [
      { ...artifact('threat', 'Threat model'), type: 'threat-model', producedBy: 'security' as const },
      { ...artifact('test', 'Test evidence'), type: 'test-evidence', producedBy: 'test' as const },
      { ...artifact('review', 'Review decision'), type: 'review-decision', producedBy: 'reviewer' as const },
    ];

    expect(evaluateGateReadiness(gateResult, inputs, [
      'threat-model', 'test-evidence', 'review-decision',
    ])).toEqual({ ready: true, reasons: [] });

    const missing = evaluateGateReadiness(gateResult, inputs.slice(0, 2), [
      'threat-model', 'test-evidence', 'review-decision',
    ]);
    expect(missing.ready).toBe(false);
    expect(missing.reasons).toContain('Required upstream artifact is absent: review-decision');
  });

  it('does not let a prose-only or explicitly blocked Gate open human review', () => {
    const proseOnly: AgentWorkflowResult = {
      draft: {
        type: 'gate-decision', name: 'Gate decision', content: 'Looks good.',
        mimeType: 'text/markdown', producedBy: 'gate', model: 'test-model',
      },
      artifacts: [],
    };
    expect(evaluateGateReadiness(proseOnly, [], []).ready).toBe(false);

    const blocked: AgentWorkflowResult = {
      ...proseOnly,
      draft: {
        ...proseOnly.draft,
        gateDecision: {
          status: 'blocked',
          rationale: 'Executable validation is incomplete.',
          missingEvidence: ['browser assertion results'],
        },
      },
    };
    const assessment = evaluateGateReadiness(blocked, [], []);
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toEqual(expect.arrayContaining([
      'Gate blocked review: Executable validation is incomplete.',
      'Gate reported missing evidence: browser assertion results',
    ]));
  });

  it('advances only after approval and a confirmed merge', () => {
    expect(reviewAdvancesIteration('approve', true)).toBe(true);
    expect(reviewAdvancesIteration('approved', true)).toBe(true);
    expect(reviewAdvancesIteration('approve', false)).toBe(false);
    expect(reviewAdvancesIteration('request_changes', false)).toBe(false);
    expect(reviewAdvancesIteration('changes_requested', false)).toBe(false);
  });

  it('rejects early, stale, wrong-token, and duplicate checkpointed reviews', () => {
    const checkpoint = {
      iterationId: iteration.id,
      iterationNumber: iteration.number,
      pullRequestNumber: iteration.pullRequestNumber!,
      reviewToken: `${iteration.id}:pr:${iteration.pullRequestNumber}:review:2`,
    };
    const submission = {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'review-submission-2',
      review: { decision: 'approve' as const, feedback: 'Approved.' },
    };

    expect(acceptIterationReviewSubmission(undefined, submission, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, { ...submission, iterationId: 'stale-iteration' }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, { ...submission, reviewToken: 'stale-token' }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, submission, new Set(['review-submission-2']))).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, submission, new Set())).toEqual({
      review: submission.review,
      idempotencyKey: 'review-submission-2',
    });
  });

  it('supersedes the checkpoint and proposal when agent feedback arrives before approval', () => {
    const checkpoint = createReviewCheckpoint(iteration, 3, preview);
    const proposal = { id: 'review-proposal-3' } as import('@orchestra/contracts').IterationReviewProposal;
    const invalidated = invalidateReviewCandidateForHumanGuidance({
      checkpoint,
      proposal,
      acceptedReview: undefined,
      invalidated: false,
      affectedRoles: [],
    }, 'builder');
    const staleApproval = {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'stale-after-agent-feedback',
      review: {
        decision: 'approve' as const,
        feedback: '',
        previewAttestation: {
          revision: previewRevision,
          imageDigest: previewImageDigest,
          triedAt: now,
        },
      },
    };

    expect(invalidated).toEqual({
      checkpoint: undefined,
      proposal: undefined,
      acceptedReview: undefined,
      invalidated: true,
      affectedRoles: ['builder'],
    });
    expect(acceptIterationReviewSubmission(
      invalidated.checkpoint,
      staleApproval,
      new Set(),
    )).toBeUndefined();
  });

  it('retains an affected-role seed when feedback arrives before a review checkpoint exists', () => {
    const seeded = invalidateReviewCandidateForHumanGuidance({
      checkpoint: undefined,
      proposal: undefined,
      acceptedReview: undefined,
      invalidated: false,
      affectedRoles: [],
    }, 'security');

    expect(seeded).toEqual({
      checkpoint: undefined,
      proposal: undefined,
      acceptedReview: undefined,
      invalidated: false,
      affectedRoles: ['security'],
    });
    expect(reactiveIterationRoles(seeded.affectedRoles)).toEqual([
      'security', 'planner', 'builder', 'test', 'reviewer', 'gate',
    ]);
  });

  it('withdraws an already accepted approval when artifact feedback arrives in the same pending-review window', () => {
    const checkpoint = createReviewCheckpoint(iteration, 4, preview);
    const submission = {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'approval-before-artifact-feedback',
      review: {
        decision: 'approve' as const,
        feedback: '',
        previewAttestation: {
          revision: previewRevision,
          imageDigest: previewImageDigest,
          triedAt: now,
        },
      },
    };
    const acceptedReview = acceptIterationReviewSubmission(checkpoint, submission, new Set());
    expect(acceptedReview).toBeDefined();

    const invalidated = invalidateReviewCandidateForHumanGuidance({
      checkpoint,
      proposal: { id: 'review-proposal-4' } as import('@orchestra/contracts').IterationReviewProposal,
      acceptedReview,
      invalidated: false,
      affectedRoles: ['builder'],
    });
    const withArtifactOwner = invalidateReviewCandidateForHumanGuidance(invalidated, 'ux');
    const duplicateOwner = invalidateReviewCandidateForHumanGuidance(withArtifactOwner, 'ux');

    expect(invalidated.acceptedReview).toBeUndefined();
    expect(invalidated.checkpoint).toBeUndefined();
    expect(invalidated.proposal).toBeUndefined();
    expect(duplicateOwner.affectedRoles).toEqual(['builder', 'ux']);
  });

  it('binds the review token to the deployed revision and image digest and requires matching unexpired approval attestation', () => {
    const checkpoint = createReviewCheckpoint(iteration, 3, preview);
    const submission = {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'revision-bound-review',
      review: { decision: 'approve' as const, feedback: '' },
    };

    expect(checkpoint).toMatchObject({
      previewRevision,
      previewImageDigest,
      previewExpiresAt: preview.expiresAt,
      previewUrl: preview.publicUrl,
    });
    expect(checkpoint.reviewToken).toContain(`:revision:${previewRevision}:`);
    expect(checkpoint.reviewToken).toContain(`:image:${previewImageDigest}:`);
    expect(acceptIterationReviewSubmission(checkpoint, submission, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      decision: 'approve',
      feedback: '',
      previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: now },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: 'f'.repeat(40), imageDigest: previewImageDigest, triedAt: now },
      },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: `sha256:${'f'.repeat(64)}`, triedAt: now },
      },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: 'not-a-date' },
      },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: '2026-08-03T14:00:00.001Z' },
      },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: now },
      },
    }, new Set())).toEqual({
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: now },
      },
      idempotencyKey: submission.idempotencyKey,
    });
  });

  it('preserves a revision-only checkpoint shape for pre-digest Temporal histories', () => {
    const checkpoint = createReviewCheckpoint(iteration, 5, preview, false);
    const legacyReview = {
      decision: 'approve',
      feedback: '',
      previewAttestation: { revision: previewRevision, triedAt: now },
    } as unknown as import('@orchestra/contracts').IterationReview;

    expect(checkpoint).toMatchObject({ previewRevision, previewUrl: preview.publicUrl });
    expect(checkpoint).not.toHaveProperty('previewImageDigest');
    expect(checkpoint).not.toHaveProperty('previewExpiresAt');
    expect(checkpoint.reviewToken).not.toContain(':image:');
    expect(acceptIterationReviewSubmission(checkpoint, {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'legacy-digest-rollout-review',
      review: legacyReview,
    }, new Set())).toBeDefined();
  });

  it('allows changes to be requested without preview attestation', () => {
    const checkpoint = createReviewCheckpoint(iteration, 4, preview);
    const submission = {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'revision-bound-changes',
      review: { decision: 'request_changes' as const, feedback: 'Please revise the empty state.' },
    };

    expect(acceptIterationReviewSubmission(checkpoint, submission, new Set())).toEqual({
      review: submission.review,
      idempotencyKey: submission.idempotencyKey,
    });
  });

  it('prevents an exact legacy review replay from approving a later checkpoint', () => {
    const legacyReview = { decision: 'approve' as const, feedback: 'Approved.' };
    const checkpoint = {
      iterationId: iteration.id,
      iterationNumber: iteration.number,
      pullRequestNumber: iteration.pullRequestNumber!,
      reviewToken: 'checkpoint-1',
    };
    const first = acceptIterationReviewSubmission(checkpoint, legacyReview, new Set());

    expect(first).toBeDefined();
    expect(acceptIterationReviewSubmission(
      { ...checkpoint, iterationId: 'later-iteration', reviewToken: 'checkpoint-2' },
      { feedback: 'Approved.', decision: 'approve' },
      new Set([first!.idempotencyKey]),
    )).toBeUndefined();
  });
});
