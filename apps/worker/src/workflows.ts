import {
  DEFAULT_PACKAGING_MAX_ATTEMPTS,
  PROJECT_ACTIVITY_TASK_QUEUE,
  VALIDATION_TASK_QUEUE,
  agentModelTaskQueue,
  agentTaskQueue,
  defaultDynamicExecutionLimits,
  deliveryAgentGraph,
  formatPackagingSandboxResults,
  packagingEvidenceSatisfiesPlan,
  previewAttestationSchema,
  type AgentArtifactDraft,
  type AgentArtifactReference,
  type AgentCommentInput,
  type AgentInteractionKind,
  type AgentMessage,
  type AgentOrder,
  type AgentOrderType,
  type AgentQuestion,
  type AgentQuestionAnswerInput,
  type AgentResult,
  type AgentRole,
  type AgentWorkflowInput,
  type AgentWorkflowResult,
  type ArtifactFeedbackInput,
  type DeliveryAgentDefinition,
  type DynamicExecutionTrace,
  type DynamicHumanDecisionRequest,
  type IterationReview,
  type IterationReviewProposal,
  type IterationReviewSubmission,
  type PackagingBuildChecksResult,
  type PackagingPlan,
  type PreviewDeploymentResult,
  type Project,
  type ProjectBrief,
  type ProjectDetail,
  type ProjectIteration,
  type ProjectSummary,
  type ReviewCheckpoint,
} from '@orchestra/contracts';
import { ParentClosePolicy, allHandlersFinished, condition, continueAsNew, defineQuery, defineSignal, defineUpdate, executeChild, getExternalWorkflowHandle, makeContinueAsNewFunc, proxyActivities, setHandler, startChild, workflowInfo } from '@temporalio/workflow';
import type * as activities from './activities.js';
import { beginAgentActivity, beginAgentCommunication, blockAgentActivity, bootstrapAgentState, completeAgentActivity, completeAgentCommunication, dequeueNextMessage, enqueueMessage, getAgentCapabilities as getAgentCapabilitiesRuntime, getAgentStatus as getAgentStatusRuntime, recordInteraction, recordResult, resolvePendingQuestion, shouldContinueAsNew, startOrder, submitOrder, type AgentBootstrap, type AgentCapabilityView, type AgentRuntimeState, type AgentStatusView } from './agent-runtime.js';
import {
  MAX_DYNAMIC_ARTIFACT_REVISIONS,
  executeDynamicArtifactOrder,
  type DynamicAgentModelActionRequest,
  type DynamicAgentModelActionResult,
  type DynamicArtifactExecutionCheckpoint,
  type DynamicModelReasoningRequest,
  type DynamicModelResult,
} from './dynamic-agent-execution.js';

const splitPersistence = proxyActivities<typeof activities>({
  taskQueue: PROJECT_ACTIVITY_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

function projectActivities() {
  return splitPersistence;
}

interface ValidationActivities {
  captureUserFlow(input: {
    project: Project;
    iteration: AgentWorkflowInput['iteration'];
    preview?: PreviewDeploymentResult;
  }): Promise<{ title: string; url: string; revision?: string }>;
  deployIterationPreview(input: {
    project: Project;
    iteration: ProjectIteration;
    existingPreview?: { iterationId: string; title: string; url: string };
  }): Promise<PreviewDeploymentResult | {
    title: string;
    url: string;
    source: 'existing' | 'adapter';
  }>;
  runPackagingBuildChecks(input: {
    project: Project;
    iteration: ProjectIteration;
    plan: PackagingPlan;
    revision?: string;
  }): Promise<PackagingBuildChecksResult>;
}

const packagingValidation = proxyActivities<Pick<ValidationActivities, 'runPackagingBuildChecks'>>({
  taskQueue: VALIDATION_TASK_QUEUE,
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 2, initialInterval: '15 seconds' },
});

function revisionBoundPreview(
  preview: Awaited<ReturnType<ValidationActivities['deployIterationPreview']>>,
): PreviewDeploymentResult {
  if (!('revision' in preview)
    || !('publicUrl' in preview)
    || !('internalUrl' in preview)
    || !('imageDigest' in preview)
    || !('expiresAt' in preview)) {
    throw new Error('Preview deployment did not return the required revision-bound contract.');
  }
  return preview;
}

const validation = proxyActivities<ValidationActivities>({
  taskQueue: VALIDATION_TASK_QUEUE,
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 2, initialInterval: '15 seconds' },
});

interface AgentWorkflowExecutionResult extends AgentWorkflowResult {
  questionIds: string[];
}

export interface AgentWorkflowWaitingResult {
  status: 'waiting_for_human';
  question: AgentQuestion;
  executionTrace: DynamicExecutionTrace;
  executionCheckpoint?: DynamicArtifactExecutionCheckpoint;
}

export interface AgentWorkflowStoppedResult {
  status: 'blocked' | 'budget_exhausted';
  reason: string;
  executionTrace: DynamicExecutionTrace;
}

export interface AgentExecutionScope {
  role: AgentRole;
  orderId: string;
}

export interface AgentRetryToken {
  globalVersion: number;
  scopeVersion: number;
}

/**
 * Workflow-local coordination for human decisions. The monotonic change
 * version prevents a signal/update handled during an Activity from being
 * missed, while retry versions are isolated to the role/order that owns the
 * question instead of releasing every concurrently blocked agent.
 */
export class AgentHumanDecisionCoordinator {
  private changeVersion = 0;
  private globalRetryVersion = 0;
  private readonly answeredQuestionIds = new Set<string>();
  private readonly acceptedQuestionIds = new Set<string>();
  private readonly questionScopes = new Map<string, AgentExecutionScope>();
  private readonly scopedRetryVersions = new Map<string, number>();

  private scopeKey(scope: AgentExecutionScope): string {
    return `${scope.role}:${scope.orderId}`;
  }

  registerQuestions(questionIds: readonly string[], scope: AgentExecutionScope): void {
    for (const questionId of questionIds) this.questionScopes.set(questionId, scope);
  }

  noteQuestionInput(questionId: string): void {
    this.acceptedQuestionIds.add(questionId);
    this.changeVersion += 1;
    const scope = this.questionScopes.get(questionId);
    if (scope) this.resume(scope);
  }

  markQuestionAnswered(questionId: string): void {
    this.acceptedQuestionIds.delete(questionId);
    this.answeredQuestionIds.add(questionId);
    this.changeVersion += 1;
  }

  beginQuestionPersistence(questionId: string): void {
    this.acceptedQuestionIds.delete(questionId);
  }

  markQuestionsAnswered(questionIds: readonly string[]): void {
    for (const questionId of questionIds) this.markQuestionAnswered(questionId);
  }

  requestQuestionRecheck(): void {
    this.changeVersion += 1;
  }

  captureQuestionWait(): number {
    return this.changeVersion;
  }

  shouldRecheckQuestions(questionIds: readonly string[], capturedVersion: number): boolean {
    return this.changeVersion > capturedVersion
      || questionIds.some((questionId) => this.acceptedQuestionIds.has(questionId))
      || questionIds.every((questionId) => this.answeredQuestionIds.has(questionId));
  }

  areQuestionsLocallyAnswered(questionIds: readonly string[]): boolean {
    return questionIds.every((questionId) => this.answeredQuestionIds.has(questionId));
  }

  captureRetry(scope: AgentExecutionScope): AgentRetryToken {
    return {
      globalVersion: this.globalRetryVersion,
      scopeVersion: this.scopedRetryVersions.get(this.scopeKey(scope)) ?? 0,
    };
  }

  shouldRetry(scope: AgentExecutionScope, token: AgentRetryToken): boolean {
    return this.globalRetryVersion > token.globalVersion
      || (this.scopedRetryVersions.get(this.scopeKey(scope)) ?? 0) > token.scopeVersion;
  }

  resume(scope?: AgentExecutionScope): void {
    this.changeVersion += 1;
    if (!scope) {
      this.globalRetryVersion += 1;
      return;
    }
    const key = this.scopeKey(scope);
    this.scopedRetryVersions.set(key, (this.scopedRetryVersions.get(key) ?? 0) + 1);
  }
}

function isAgentWorkflowWaitingResult(value: unknown): value is AgentWorkflowWaitingResult {
  return typeof value === 'object' && value !== null
    && 'status' in value && value.status === 'waiting_for_human'
    && 'question' in value;
}

function isAgentWorkflowStoppedResult(value: unknown): value is AgentWorkflowStoppedResult {
  return typeof value === 'object' && value !== null
    && 'status' in value && (value.status === 'blocked' || value.status === 'budget_exhausted')
    && 'reason' in value;
}

type ModelReasoningWorkflow = (input: DynamicModelReasoningRequest) => Promise<DynamicModelResult>;
type AgentModelActionWorkflow = (input: DynamicAgentModelActionRequest) => Promise<DynamicAgentModelActionResult>;

function boundedModelChildTimeout(
  request: DynamicModelReasoningRequest | DynamicAgentModelActionRequest,
) {
  const budget = 'action' in request && request.action === 'finalize_candidate'
    ? undefined
    : request.inferenceBudget;
  return budget
    ? { workflowExecutionTimeout: Math.max(1, budget.deadlineEpochMs - Date.now()) }
    : {};
}

export function agentArtifactPersistenceOperationKey(
  input: AgentWorkflowInput,
  fallbackExecutionId: string,
): string {
  return `${input.artifactOperationId ?? input.executionOperationId ?? fallbackExecutionId}/artifact-commit`;
}

export function agentHumanDecisionOperationKey(
  input: AgentWorkflowInput,
  fallbackExecutionId: string,
  decisionKey: string,
): string {
  return `${input.executionOperationId ?? fallbackExecutionId}/human/${decisionKey}`;
}

export function agentUserFlowMediaOperationKey(
  input: AgentWorkflowInput,
  fallbackExecutionId: string,
): string {
  return `${input.artifactOperationId ?? input.executionOperationId ?? fallbackExecutionId}/user-flow-media`;
}

async function executeAgent(
  input: AgentWorkflowInput,
  modelRequestId = `${workflowInfo().workflowId}/model`,
  assignedOrder?: AgentOrder,
  executionCheckpoint?: DynamicArtifactExecutionCheckpoint,
): Promise<AgentArtifactDraft | AgentWorkflowExecutionResult | AgentWorkflowWaitingResult | AgentWorkflowStoppedResult> {
  const revisionBoundAssuranceLedger = input.revisionBoundAssurance ?? Boolean(input.preview);
  const assuranceRole = input.role === 'test' || input.role === 'reviewer' || input.role === 'gate';
  if (revisionBoundAssuranceLedger && assuranceRole && !input.preview) {
    throw new Error(`${input.role} evidence requires an immutable preview revision.`);
  }
  const order = assignedOrder ?? runtimeOrderForExecution(input, `${modelRequestId}/order`);
  const ledgerOrder = input.executionOperationId && order.orderId !== input.executionOperationId
    ? { ...order, orderId: input.executionOperationId }
    : order;
  let artifactOperationKey = agentArtifactPersistenceOperationKey(input, modelRequestId);
  const mayRecoverArtifact = Boolean(input.artifactOperationId || input.executionOperationId);
  const recoveredDraft = !mayRecoverArtifact
    ? undefined
    : await projectActivities().loadAgentArtifactOperationDraft(input.project.id, artifactOperationKey, {
      iterationId: input.iteration.id,
      type: input.artifactType,
      producedBy: input.role,
      storage: revisionBoundAssuranceLedger && assuranceRole ? 'ledger' : 'repository',
      sourceRevision: revisionBoundAssuranceLedger && assuranceRole ? input.preview!.revision : null,
    });
  if (!recoveredDraft) {
    await projectActivities().recordAgentStarted(input.project, input.iteration, input.role, input.inputArtifacts ?? [], input.supervisedBy ?? []);
    await projectActivities().persistAgentOrderLedger(
      input.project.id,
      input.iteration.id,
      input.role,
      ledgerOrder,
      `iteration:${input.iteration.number}:${input.role}`,
      input.preview?.revision,
    );
  }
  let draft: AgentArtifactDraft;
  let executionTrace: DynamicExecutionTrace | undefined;
  if (recoveredDraft) {
    draft = recoveredDraft;
    executionTrace = recoveredDraft.executionTrace;
  } else {
    const checkpoint = executionCheckpoint;
    const executionId = checkpoint?.executionId ?? modelRequestId;
    artifactOperationKey = agentArtifactPersistenceOperationKey(input, executionId);
    const dynamic = await executeDynamicArtifactOrder({
      executionId,
      input,
      contextVersion: input.executionContextVersion ?? input.iteration.number,
      limits: input.executionLimits,
      requiredDecisionIds: input.requiredDecisionIds,
      authorityActions: [...order.authority.permittedActions],
      allowedActivities: order.constraints.allowedTools,
      mutationScopes: [
        ...(order.scope.repositoryPaths ?? []),
        ...(order.constraints.allowedRepositoryPaths ?? []),
      ],
      requiredEvidenceRefs: order.requiredEvidence
        .filter((requirement) => requirement.required)
        .flatMap((requirement) => requirement.subjectRefs),
      availableEvidenceRefs: [
        input.iteration.id,
        ...(input.inputArtifacts ?? []).flatMap((artifact) => [
          artifact.id,
          artifact.type,
          ...(artifact.repositoryUrl ? [artifact.repositoryUrl] : []),
        ]),
        ...(input.preview ? [input.preview.revision, `revision:${input.preview.revision}`] : []),
      ],
      enforceProviderBudgets: true,
      discardTerminalControlActions: true,
      serializeArtifactActions: true,
      bindPlanningContextVersion: true,
      discardModelAuthoredArguments: true,
      normalizeDecisionOptions: true,
      normalizeDecisionEnvelope: true,
      normalizeArtifactStateTransitions: true,
      ...(checkpoint !== undefined ? {
        refreshCandidateAfterHumanDecision: true,
        extendPlanningAfterHumanDecision: true,
        honorHumanReviewWaiver: true,
        deferQuestionsAfterHumanReviewWaiver: true,
      } : {}),
      acceptReasoningTokens: true,
      ...(checkpoint ? { checkpoint } : {}),
    }, {
      reason: async (request, operationKey) => await executeChild<ModelReasoningWorkflow>(
        'modelReasoningWorkflow',
        {
          workflowId: operationKey,
          taskQueue: agentModelTaskQueue(input.role),
          args: [request],
          ...boundedModelChildTimeout(request),
        },
      ),
      act: async (request, operationKey) => await executeChild<AgentModelActionWorkflow>(
        'agentModelActionWorkflow',
        {
          workflowId: operationKey,
          taskQueue: agentModelTaskQueue(input.role),
          args: [request],
          ...boundedModelChildTimeout(request),
        },
      ),
    });
    executionTrace = dynamic.trace;
    if (dynamic.status === 'waiting_for_human') {
      const question = await projectActivities().recordDynamicAgentQuestion(
        input.project,
        input.iteration,
        input.role,
        dynamic.decision,
        agentHumanDecisionOperationKey(input, executionId, dynamic.decision.decisionKey),
      );
      await projectActivities().persistAgentExecutionLedger(
        input.project.id,
        input.iteration.id,
        input.role,
        ledgerOrder,
        'waiting_for_human',
        dynamic.trace,
        [],
        `iteration:${input.iteration.number}:${input.role}`,
        input.preview?.revision,
      );
      return {
        status: 'waiting_for_human',
        question,
        executionTrace: dynamic.trace,
        executionCheckpoint: dynamic.checkpoint,
      };
    }
    if (dynamic.status !== 'completed') {
      await projectActivities().persistAgentExecutionLedger(
        input.project.id,
        input.iteration.id,
        input.role,
        ledgerOrder,
        dynamic.status,
        dynamic.trace,
        [],
        `iteration:${input.iteration.number}:${input.role}`,
        input.preview?.revision,
      );
      return {
        status: dynamic.status,
        reason: dynamic.reason,
        executionTrace: dynamic.trace,
      };
    }
    draft = { ...dynamic.draft, executionTrace: dynamic.trace };
  }
  draft.name = input.artifactName;
  const recordTestEvidence = async (): Promise<void> => {
    if (input.role === 'test' && input.preview) {
      const recording = await validation.captureUserFlow({ project: input.project, iteration: input.iteration, preview: input.preview });
      if (recording.revision !== input.preview.revision) {
        throw new Error('User-flow recording did not attest to the requested preview revision.');
      }
      await projectActivities().recordUserFlowMedia(
        input.project,
        input.iteration,
        recording,
        input.preview,
        agentUserFlowMediaOperationKey(input, modelRequestId),
      );
    } else if (input.role === 'test' && input.project.previewUrl) {
      const recording = await validation.captureUserFlow({ project: input.project, iteration: input.iteration });
      await projectActivities().recordUserFlowMedia(
        input.project,
        input.iteration,
        recording,
        undefined,
        agentUserFlowMediaOperationKey(input, modelRequestId),
      );
    }
  };
  await recordTestEvidence();
  const recorded = revisionBoundAssuranceLedger && assuranceRole
    ? await projectActivities().recordAgentArtifact(
      input.project,
      input.iteration,
      draft,
      artifactOperationKey,
      {
        storage: 'ledger',
        sourceRevision: input.preview!.revision,
        bindRecoveryEnvelope: true,
      },
    )
    : await projectActivities().recordAgentArtifact(
      input.project,
      input.iteration,
      draft,
      artifactOperationKey,
      { storage: 'repository', bindRecoveryEnvelope: true },
    );
  if (recorded.draft) {
    draft = recorded.draft;
    executionTrace = recorded.draft.executionTrace;
  }
  if (!input.deferCompletionLedger) {
    await projectActivities().persistAgentExecutionLedger(
      input.project.id,
      input.iteration.id,
      input.role,
      ledgerOrder,
      'completed',
      executionTrace,
      recorded.artifacts.map((artifact) => artifact.id),
      `iteration:${input.iteration.number}:${input.role}`,
      input.preview?.revision,
    );
  }
  return {
    draft: {
      ...draft,
      content: 'Artifact body stored outside Workflow history; resolve the returned artifact references when needed.',
      attachments: undefined,
    },
    artifacts: recorded.artifacts,
    questionIds: recorded.questionIds,
  };
}

export const managerAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const requirementsAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const productAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const uxAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const architectureAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const dataAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const securityAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const plannerAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const builderAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const testAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const reviewerAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const gateAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const deploymentAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);
export const validationAgentWorkflow = (input: AgentWorkflowInput) => executeAgent(input);

interface ResumableAgentWorkflowInvocation {
  input: AgentWorkflowInput;
  modelRequestId: string;
  order?: AgentOrder;
  executionCheckpoint: DynamicArtifactExecutionCheckpoint;
}

/** Resumable agent entry point after a recorded human decision. */
export const resumableAgentWorkflow = (invocation: ResumableAgentWorkflowInvocation) => executeAgent(
  invocation.input,
  invocation.modelRequestId,
  invocation.order,
  invocation.executionCheckpoint,
);

interface AgentExecutionCommandPayload {
  orderId: string;
  order?: AgentOrder;
  input: AgentWorkflowInput;
  replyWorkflowId: string;
  executionCheckpoint?: DynamicArtifactExecutionCheckpoint;
}

interface AgentExecutionResponse {
  orderId: string;
  role: AgentRole;
  result?: AgentWorkflowExecutionResult;
  waiting?: AgentWorkflowWaitingResult;
  stopped?: AgentWorkflowStoppedResult;
  error?: string;
}

type AgentExecutionCommand = AgentMessage<AgentExecutionCommandPayload>;

export function isAgentExecutionCommandMessage(message: AgentMessage): message is AgentExecutionCommand {
  if (message.kind !== 'COMMAND' || message.name !== 'order.submit') return false;
  if (typeof message.payload !== 'object' || message.payload === null || Array.isArray(message.payload)) return false;
  const payload = message.payload as Record<string, unknown>;
  if (typeof payload.orderId !== 'string' || payload.orderId.trim().length === 0
    || typeof payload.replyWorkflowId !== 'string' || payload.replyWorkflowId.trim().length === 0
    || typeof payload.input !== 'object' || payload.input === null || Array.isArray(payload.input)) return false;
  const input = payload.input as Record<string, unknown>;
  return typeof input.role === 'string'
    && typeof input.project === 'object' && input.project !== null
    && typeof input.iteration === 'object' && input.iteration !== null;
}

function mailboxInteractionKind(message: AgentMessage): AgentInteractionKind {
  if (message.name === 'artifact.handoff') return 'handoff';
  if (message.name === 'agent.blocked' || message.kind === 'ESCALATION') return 'blocker';
  const kinds: Partial<Record<AgentMessage['kind'], AgentInteractionKind>> = {
    COMMAND: 'order', EVENT: 'status', QUESTION: 'question', RESPONSE: 'answer',
    DECISION: 'decision', EVIDENCE: 'evidence', FINDING: 'finding', STATUS: 'status',
    CONTROL: 'control',
  };
  return kinds[message.kind] ?? 'status';
}

function mailboxMessageSummary(message: AgentMessage): string {
  if (typeof message.payload === 'object' && message.payload !== null && !Array.isArray(message.payload)) {
    const summary = (message.payload as Record<string, unknown>).summary;
    if (typeof summary === 'string' && summary.trim().length > 0) return summary;
  }
  return message.name;
}

function mailboxMessageSenderLabel(message: AgentMessage): string {
  if (typeof message.payload === 'object' && message.payload !== null && !Array.isArray(message.payload)) {
    if ((message.payload as Record<string, unknown>).authoredBy === 'human') return 'the human collaborator';
  }
  return message.sender.role;
}

function mailboxMessageIteration(message: AgentMessage): number {
  if (typeof message.payload === 'object' && message.payload !== null && !Array.isArray(message.payload)) {
    const iterationNumber = (message.payload as Record<string, unknown>).iterationNumber;
    if (typeof iterationNumber === 'number' && Number.isInteger(iterationNumber) && iterationNumber > 0) {
      return iterationNumber;
    }
  }
  return Math.max(1, message.projectStateVersion);
}

export const receiveAgentCommand = defineSignal<[AgentMessage]>('receiveMessage');
export const agentExecutionCompleted = defineSignal<[AgentExecutionResponse]>('agentExecutionCompleted');
export const agentQuestionResolved = defineSignal<[string]>('agentQuestionResolved');
export const getAgentStatus = defineQuery<AgentStatusView>('getStatus');
export const getAgentCapabilities = defineQuery<AgentCapabilityView>('getCapabilities');

/**
 * A long-lived role actor. It keeps a durable mailbox and common query surface,
 * serializes meaningful work, and returns to an idle wait after every order.
 */
export async function persistentAgentRoleWorkflow(bootstrap: AgentBootstrap): Promise<void> {
  let state: AgentRuntimeState = bootstrapAgentState(bootstrap);
  setHandler(receiveAgentCommand, (message) => {
    state = enqueueMessage(state, message);
  });
  setHandler(agentQuestionResolved, (questionId) => {
    state = resolvePendingQuestion(state, questionId);
  });
  setHandler(getAgentStatus, () => getAgentStatusView(state));
  setHandler(getAgentCapabilities, () => getAgentCapabilitiesView(state));

  async function continueActorIfNeeded(): Promise<void> {
    // The compact actor bootstrap does not yet carry blocker records. Keep a
    // blocked actor on its current run until a resumed order resolves it.
    if (state.status === 'BLOCKED' || state.presentationState === 'blocked') return;
    const continuationDue = shouldContinueAsNew(state)
      || (workflowInfo().continueAsNewSuggested
        && shouldContinueAsNew(state, 1));
    if (state.mailbox.length > 0 || !continuationDue) return;
    const recent = state.receivedMessages.slice(-100);
    const nextBootstrap: AgentBootstrap = {
      address: state.address,
      role: state.role,
      mode: state.mode,
      presentationState: state.presentationState,
      activity: state.activity,
      stateChangedAt: state.stateChangedAt,
      graphVersion: state.graphVersion,
      projectStateVersion: state.projectStateVersion,
      stateVersion: state.stateVersion,
      continuationSequence: state.continuationSequence + 1,
      recentMessageIds: recent.map((message) => message.messageId),
      recentIdempotencyKeys: recent.map((message) => message.idempotencyKey),
      continueAsNewEventThreshold: state.continueAsNewEventThreshold,
    };
    await makeContinueAsNewFunc<typeof persistentAgentRoleWorkflow>({
      taskQueue: agentTaskQueue(state.role),
    })(nextBootstrap);
  }

  while (true) {
    await condition(() => state.mailbox.length > 0);
    const dequeued = dequeueNextMessage(state);
    state = dequeued.state;
    const message = dequeued.message;
    if (!message) continue;

    if (!isAgentExecutionCommandMessage(message)) {
      const summary = mailboxMessageSummary(message);
      let receipt: ReturnType<typeof beginAgentCommunication> | undefined;
      try {
        // This branch is intentionally one-way: it acknowledges and projects
        // the received fact, but never invokes a model or emits a response.
        await projectActivities().transitionAgentMessage(
          message.projectId,
          message.idempotencyKey,
          'acknowledged',
          state.role,
        );
        receipt = beginAgentCommunication(
          state,
          message,
          mailboxMessageIteration(message),
          mailboxInteractionKind(message),
          summary,
        );
        state = receipt.state;
        await persistActorRuntimeState(
          state,
          { iterationId: message.iterationId },
          message.correlationId,
        );
        state = completeAgentCommunication(
          state,
          receipt.baseline,
          receipt.interactionId,
          `Processed ${message.name} from ${mailboxMessageSenderLabel(message)}; monitoring for relevant changes.`,
        );
        await persistActorRuntimeState(
          state,
          { iterationId: message.iterationId },
          message.correlationId,
        );
        await projectActivities().transitionAgentMessage(
          message.projectId,
          message.idempotencyKey,
          'completed',
          state.role,
        );
      } catch (error) {
        if (receipt) {
          state = completeAgentCommunication(
            state,
            receipt.baseline,
            receipt.interactionId,
            `Received ${message.name}, but its durable receipt could not be completed.`,
          );
        }
        await projectActivities().transitionAgentMessage(
          message.projectId,
          message.idempotencyKey,
          'failed',
          state.role,
        );
      }
      await continueActorIfNeeded();
      continue;
    }

    const payload = message.payload as AgentExecutionCommandPayload;
    let terminalResponse: AgentExecutionResponse | undefined;
    try {
    {
      await projectActivities().transitionAgentMessage(
        message.projectId,
        message.idempotencyKey,
        'acknowledged',
        state.role,
      );
    }
    {
      if (payload.order) {
        state = startOrder(submitOrder(state, payload.order), payload.order.orderId);
      }
      state = beginAgentActivity(state, {
        type: actorActivityType(payload.input.role),
        summary: actorActivitySummary(payload.input),
        state: actorPresentationState(payload.input.role),
      });
      state = recordInteraction(state, {
        id: `started:${message.messageId}`,
        messageId: message.messageId,
        correlationId: message.correlationId,
        iterationNumber: payload.input.iteration.number,
        from: state.role,
        to: ['project'],
        kind: 'status',
        name: `${payload.input.role} activity started`,
        summary: actorActivitySummary(payload.input),
        status: 'in_progress',
        createdAt: new Date().toISOString(),
        live: true,
      });
      await persistActorRuntimeState(state, payload.input, message.correlationId);
    }
      const execution = await executeAgent(
        payload.input,
        `${workflowInfo().workflowId}/model/${payload.orderId}`,
        payload.order,
        payload.executionCheckpoint,
      );
      if (isAgentWorkflowWaitingResult(execution)) {
        terminalResponse = {
          orderId: payload.orderId,
          role: state.role,
          waiting: execution,
        };
        {
          state = recordInteraction(state, {
            id: `question:${execution.question.id}`,
            messageId: message.messageId,
            correlationId: message.correlationId,
            iterationNumber: payload.input.iteration.number,
            from: state.role,
            to: ['human'],
            kind: 'question',
            name: `${state.role} needs a human decision`,
            summary: execution.question.question,
            status: 'pending',
            createdAt: execution.question.createdAt,
            live: true,
          });
          if (payload.order) {
            state = recordResult(state, {
              orderId: payload.order.orderId,
              role: state.role,
              status: 'PARTIAL',
              summary: `Waiting for the human decision ${execution.question.decisionKey}.`,
              outputs: [],
              evidence: [],
              findings: [],
              decisions: [],
              assumptionsCreated: [],
              assumptionsInvalidated: [],
              unresolvedQuestions: [{
                questionId: execution.question.id,
                question: execution.question.question,
                askedBy: state.address,
                targetRoles: ['manager'],
                status: 'OPEN',
                contextRefs: [payload.input.iteration.id, execution.question.decisionKey],
                createdAt: execution.question.createdAt,
              }],
              limitations: [],
              recommendedActions: [],
              sourceVersions: payload.order.sourceArtifactVersions,
              stateVersion: state.stateVersion,
            });
          }
          await persistActorRuntimeState(state, payload.input, message.correlationId);
        }
        {
          await projectActivities().transitionAgentMessage(
            message.projectId,
            message.idempotencyKey,
            'completed',
            state.role,
          );
        }
        await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, terminalResponse);
        await continueActorIfNeeded();
        continue;
      }
      if (isAgentWorkflowStoppedResult(execution)) {
        terminalResponse = {
          orderId: payload.orderId,
          role: state.role,
          stopped: execution,
        };
        const terminalSummary = `${execution.status.toUpperCase()}: ${execution.reason}`;
        {
          const activeOrder = payload.order && state.orders.find((record) =>
            record.order.orderId === payload.order!.orderId
            && ['ACCEPTED', 'IN_PROGRESS', 'BLOCKED'].includes(record.status));
          if (payload.order && activeOrder) {
            state = recordResult(state, {
              orderId: payload.order.orderId,
              role: state.role,
              status: 'FAILED',
              summary: terminalSummary,
              outputs: [],
              evidence: [],
              findings: [],
              decisions: [],
              assumptionsCreated: [],
              assumptionsInvalidated: [],
              unresolvedQuestions: [],
              limitations: [{
                limitationId: `${execution.status}:${payload.order.orderId}`,
                description: execution.reason,
                impact: execution.status === 'budget_exhausted'
                  ? 'The bounded role order reached its configured execution ceiling.'
                  : 'The bounded role order cannot advance until the blocker is resolved.',
                affectedRefs: [payload.input.iteration.id],
              }],
              recommendedActions: [],
              sourceVersions: payload.order.sourceArtifactVersions,
              stateVersion: state.stateVersion,
            });
          }
          state = blockAgentActivity(state, terminalSummary);
          await persistActorRuntimeState(state, payload.input, message.correlationId);
        }
        state = recordInteraction(state, {
          id: `${execution.status}:${message.messageId}`,
          messageId: message.messageId,
          correlationId: message.correlationId,
          iterationNumber: payload.input.iteration.number,
          from: 'system',
          to: [state.role],
          kind: 'blocker',
          name: `${state.role} order ${execution.status.replaceAll('_', ' ')}`,
          summary: terminalSummary,
          status: 'blocked',
          createdAt: new Date().toISOString(),
          live: true,
        });
        {
          await projectActivities().transitionAgentMessage(
            message.projectId,
            message.idempotencyKey,
            'failed',
            state.role,
          );
        }
        await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, terminalResponse);
        await continueActorIfNeeded();
        continue;
      }
      const result: AgentWorkflowExecutionResult = 'draft' in execution
        ? execution
        : { draft: execution, artifacts: [], questionIds: [] };
      terminalResponse = {
        orderId: payload.orderId,
        role: state.role,
        result,
      };
      state = recordInteraction(state, {
        id: `completed:${message.messageId}`,
        messageId: message.messageId,
        correlationId: message.correlationId,
        iterationNumber: payload.input.iteration.number,
        from: state.role,
        to: ['project'],
        kind: 'handoff',
        name: `${payload.input.artifactName} handed off`,
        summary: `${state.role} completed its bounded order and returned versioned artifacts to the project organism.`,
        status: 'completed',
        createdAt: new Date().toISOString(),
      });
      {
        if (payload.order) {
          const runtimeResult: AgentResult = {
          orderId: payload.order.orderId,
          role: state.role,
          status: 'COMPLETED',
          summary: `${payload.input.artifactName} passed deterministic role completion checks.`,
          outputs: result.artifacts.map((artifact) => ({
            artifactId: artifact.id,
            artifactType: artifact.type,
            version: String(artifact.version),
            name: artifact.name,
            ownerRole: artifact.producedBy,
            status: 'PROPOSED',
            storageUri: artifact.repositoryUrl ?? undefined,
          })),
          evidence: [],
          findings: [],
          decisions: [],
          assumptionsCreated: [],
          assumptionsInvalidated: [],
          unresolvedQuestions: [],
          limitations: [],
          recommendedActions: [],
          sourceVersions: payload.order.sourceArtifactVersions,
          stateVersion: state.stateVersion,
          };
          state = recordResult(state, runtimeResult);
        }
        state = completeAgentActivity(
          state,
          `${payload.input.artifactName} is handed off; monitoring relevant project changes.`,
        );
        await persistActorRuntimeState(state, payload.input, message.correlationId);
      }
      {
        await projectActivities().transitionAgentMessage(
          message.projectId,
          message.idempotencyKey,
          'completed',
          state.role,
        );
      }
      await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, terminalResponse);
    } catch (error) {
      if (terminalResponse) {
        try {
          await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, terminalResponse);
        } catch {
          // The durable terminal outcome must not be reclassified or rerun just
          // because its reply target has already closed.
        }
        await continueActorIfNeeded();
        continue;
      }
      let failure = describeModelFailure(error);
      try {
        {
          const activeOrder = payload.order && state.orders.find((record) =>
            record.order.orderId === payload.order!.orderId
            && ['ACCEPTED', 'IN_PROGRESS', 'BLOCKED'].includes(record.status));
          if (payload.order && activeOrder) {
            state = recordResult(state, {
          orderId: payload.order.orderId,
          role: state.role,
          status: 'FAILED',
          summary: failure,
          outputs: [],
          evidence: [],
          findings: [],
          decisions: [],
          assumptionsCreated: [],
          assumptionsInvalidated: [],
          unresolvedQuestions: [],
          limitations: [{
            limitationId: `blocked:${payload.order.orderId}`,
            description: failure,
            impact: 'The bounded role order cannot advance until the blocker is resolved.',
            affectedRefs: [payload.input.iteration.id],
          }],
          recommendedActions: [],
          sourceVersions: payload.order.sourceArtifactVersions,
          stateVersion: state.stateVersion,
            });
          }
          state = blockAgentActivity(state, failure);
        }
        state = recordInteraction(state, {
          id: `blocked:${message.messageId}`,
          messageId: message.messageId,
          correlationId: message.correlationId,
          iterationNumber: payload.input.iteration.number,
          from: 'system',
          to: [state.role],
          kind: 'blocker',
          name: `${state.role} order blocked`,
          summary: failure,
          status: 'blocked',
          createdAt: new Date().toISOString(),
          live: true,
        });
        {
          await persistActorRuntimeState(state, payload.input, message.correlationId);
        }
      } catch (cleanupError) {
        failure = `${failure} Actor cleanup also failed: ${describeModelFailure(cleanupError)}`.slice(0, 10_000);
      }
      {
        try {
          await projectActivities().transitionAgentMessage(
            message.projectId,
            message.idempotencyKey,
            'failed',
            state.role,
          );
        } catch (ledgerError) {
          failure = `${failure} Message-ledger cleanup also failed: ${describeModelFailure(ledgerError)}`.slice(0, 10_000);
        }
      }
      await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, {
        orderId: payload.orderId,
        role: state.role,
        error: failure,
      });
    }

    await continueActorIfNeeded();
  }
}

async function persistActorRuntimeState(
  state: AgentRuntimeState,
  input: AgentWorkflowInput | { iterationId?: string },
  correlationId: string,
) {
  await projectActivities().persistAgentRuntimeState({
    projectId: state.address.projectId,
    iterationId: 'iteration' in input ? input.iteration.id : input.iterationId,
    role: state.role,
    state: state.presentationState,
    stateVersion: state.stateVersion,
    activity: state.activity ? { type: state.activity.type, summary: state.activity.summary } : null,
    waitingReason: state.presentationState === 'waiting_on_agent' || state.presentationState === 'waiting_on_human'
      ? state.activity?.summary
      : undefined,
    blockerReferences: state.blockers.map((blocker) => blocker.blockerId),
    workflowRunId: workflowInfo().runId,
    correlationId,
    operationKey: `${state.address.workflowId}:state:${state.stateVersion}`,
    enteredAt: state.stateChangedAt,
  });
}

function actorPresentationState(role: AgentRole): 'planning' | 'working' | 'reviewing' {
  if (['test', 'reviewer', 'gate', 'validation'].includes(role)) return 'reviewing';
  if (['builder', 'deployment'].includes(role)) return 'working';
  return 'planning';
}

function actorActivityType(role: AgentRole) {
  const types: Record<AgentRole, string> = {
    manager: 'iteration_coordination', requirements: 'requirements_analysis', product: 'increment_shaping',
    ux: 'journey_design', architecture: 'architecture_design', data: 'data_design', security: 'threat_modeling',
    planner: 'work_planning', builder: 'implementation', test: 'browser_verification', reviewer: 'evidence_review',
    gate: 'readiness_evaluation', deployment: 'preview_deployment', validation: 'outcome_validation',
  };
  return types[role];
}

function actorActivitySummary(input: AgentWorkflowInput) {
  const summaries: Record<AgentRole, string> = {
    manager: 'Evaluating the iteration objective, scope, obligations, and review boundary.',
    requirements: 'Comparing the project intent with explicit acceptance criteria and edge cases.',
    product: 'Defining the smallest useful increment and measurable success signals.',
    ux: 'Mapping the primary user journey, visible states, and accessibility expectations.',
    architecture: 'Defining system boundaries, interfaces, decisions, and technical risks.',
    data: 'Reviewing persistence, migration, retention, and sensitive-data requirements.',
    security: 'Threat-modeling the current architecture, dependencies, storage, and deployment shape.',
    planner: 'Ordering bounded work packages, evidence, permissions, and dependencies.',
    builder: `Implementing ${input.artifactName} against the approved iteration plan.`,
    test: 'Running browser and acceptance verification against the exact preview revision.',
    reviewer: 'Comparing implementation and Test evidence with the requirements baseline.',
    gate: 'Evaluating mandatory evidence, findings, and revision-bound readiness.',
    deployment: 'Preparing a permission-bounded deployment for the authorized revision.',
    validation: 'Checking the delivered result against the intended human outcome.',
  };
  return summaries[input.role];
}

const roleOrderTypes: Record<AgentRole, AgentOrderType> = {
  manager: 'DEFINE_INCREMENT',
  requirements: 'ELABORATE_REQUIREMENTS',
  product: 'DEFINE_INCREMENT',
  ux: 'DESIGN_UX',
  architecture: 'DESIGN_ARCHITECTURE',
  data: 'DESIGN_DATA',
  security: 'THREAT_MODEL',
  planner: 'PLAN_WORK',
  builder: 'IMPLEMENT',
  test: 'EXECUTE_TESTS',
  reviewer: 'REVIEW',
  gate: 'EVALUATE_GATE',
  deployment: 'DEPLOY',
  validation: 'VALIDATE_OUTCOME',
};

const roleOrderModes: Record<AgentRole, AgentOrder['loopPolicy']['mode']> = {
  manager: 'DEFINITION',
  requirements: 'DEFINITION',
  product: 'DEFINITION',
  ux: 'DESIGN',
  architecture: 'DESIGN',
  data: 'DESIGN',
  security: 'DESIGN',
  planner: 'PLANNING',
  builder: 'IMPLEMENTATION',
  test: 'TESTING',
  reviewer: 'REVIEW',
  gate: 'GATING',
  deployment: 'DEPLOYMENT',
  validation: 'VALIDATION',
};

export function runtimeOrderForExecution(input: AgentWorkflowInput, orderId: string): AgentOrder {
  const limits = { ...defaultDynamicExecutionLimits, ...input.executionLimits };
  const scopeRefs = [input.iteration.id, input.artifactType];
  return {
    orderId,
    type: roleOrderTypes[input.role],
    objective: `Produce ${input.artifactName} for iteration ${input.iteration.number}: ${input.iteration.objective}`,
    scope: {
      included: [input.iteration.id],
      excluded: [],
      affectedComponents: [],
      workPackageRefs: [input.artifactType],
      repositoryPaths: [],
    },
    expectedOutputs: [{
      artifactType: input.artifactType,
      description: `${input.artifactName} must satisfy its deterministic artifact contract.`,
      required: true,
      ownerRole: input.role,
    }],
    acceptanceCriteria: [{
      criterionId: `${orderId}:artifact-contract`,
      description: 'The current candidate passes independent review and deterministic schema validation.',
      mandatory: true,
      requirementRefs: [input.artifactType],
      verificationMethod: 'Dynamic execution completion verifier',
    }],
    requiredEvidence: [],
    dependencies: (input.inputArtifacts ?? []).map((artifact) => ({
      dependencyId: `${orderId}:artifact:${artifact.id}`,
      kind: 'ARTIFACT',
      refId: artifact.id,
      status: 'SATISFIED',
      required: true,
      description: `${artifact.name} was supplied as a versioned handoff.`,
    })),
    constraints: {
      allowedRepositoryPaths: [],
      allowedTools: [
        'model.generate_artifact',
        'model.review_artifact',
        'model.revise_artifact',
      ],
      timeBudgetMinutes: Math.ceil(limits.maxWallClockMs / 60_000),
      tokenBudget: limits.maxTokens,
    },
    loopPolicy: {
      mode: roleOrderModes[input.role],
      reasoningDepth: 'STANDARD',
      evidenceStrength: input.role === 'gate' || input.role === 'security' ? 'STRICT' : 'STANDARD',
      requiredCollaborators: [...(input.supervisedBy ?? [])],
      optionalCollaborators: [],
      maxParallelActions: limits.maxConcurrentReadActions,
      maxIterations: limits.maxPlanningRounds,
      maxRemediationRounds: MAX_DYNAMIC_ARTIFACT_REVISIONS,
      requiredApprovals: [],
      requiredGates: input.role === 'deployment' ? ['gate'] : [],
      onMissingInformation: 'ASK',
      onConflict: 'RECONCILE',
      onFailure: 'REPLAN',
      interruptionPolicy: 'SAFE_BOUNDARY',
    },
    authority: {
      grantId: `iteration:${input.iteration.id}:${input.role}:${orderId}`,
      issuerRole: 'manager',
      level: 'ITERATION',
      permittedActions: [roleOrderTypes[input.role], 'EXECUTE_BOUNDED_STEP'],
      permittedTargets: [input.role],
      scopeRefs,
      mayDelegate: false,
    },
    sourceArtifactVersions: (input.inputArtifacts ?? []).map((artifact) => ({
      artifactId: artifact.id,
      artifactType: artifact.type,
      version: 'current',
      name: artifact.name,
      ownerRole: artifact.producedBy,
      status: 'ACCEPTED',
      storageUri: artifact.repositoryUrl ?? undefined,
    })),
    priority: 'NORMAL',
  };
}

// Avoid name collisions between Temporal handler definitions and pure views.
function getAgentStatusView(state: AgentRuntimeState) {
  return getAgentStatusRuntime(state);
}

function getAgentCapabilitiesView(state: AgentRuntimeState) {
  return getAgentCapabilitiesRuntime(state);
}

// Release agents are part of the persistent organism, but they do not execute
// until a human and Gate authorize an immutable release. The current iteration
// review remains a planning/build gate, so it must never imply a deployment.
const iterationAgentGraph: readonly DeliveryAgentDefinition[] = deliveryAgentGraph.filter(
  (step: DeliveryAgentDefinition) => step.activation !== 'authorized_release',
);

function agentWorkflowId(projectId: string, role: AgentRole) {
  return `project/${projectId}/agent/${role}`;
}

function artifactMatches(pattern: string, type: string) {
  return pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}

function collectInputArtifacts(step: DeliveryAgentDefinition, completed: ReadonlyMap<AgentRole, AgentWorkflowResult>): AgentArtifactReference[] {
  return [...completed.values()].flatMap((result) => result.artifacts)
    .filter((artifact) => step.consumes.some((pattern) => artifactMatches(pattern, artifact.type)))
    .map((artifact) => ({
      ...artifact,
      // Never propagate legacy inline bodies into a new Workflow command.
      content: undefined,
    }));
}

export interface GateReadiness {
  ready: boolean;
  reasons: string[];
}

/**
 * Gate is the only role whose deterministic parent check happens after its
 * durable handoff. New workflow histories therefore keep its logical order
 * open until that check has passed.
 */
export function defersCompletionUntilGateReadiness(
  role: AgentRole,
  parentVerificationEnabled: boolean,
): boolean {
  return parentVerificationEnabled && role === 'gate';
}

/**
 * Parent verification can reject an otherwise persisted agent result. Such a
 * result is useful diagnostic material, but it must not satisfy the order's
 * canonical obligations.
 */
export function parentVerificationBlockedLedgerProjection(
  result: AgentWorkflowResult,
  failureReason: string,
): {
  status: 'blocked';
  trace: DynamicExecutionTrace | undefined;
  artifactIds: string[];
  failureReason: string;
} {
  return {
    status: 'blocked',
    trace: result.draft.executionTrace,
    artifactIds: [],
    failureReason,
  };
}

/**
 * Keeps the release-to-human-review boundary deterministic. Model-authored prose
 * is never enough: Gate must return a structured pass and must actually have
 * received every evidence type declared by the delivery graph.
 */
export function evaluateGateReadiness(
  gateResult: AgentWorkflowResult | undefined,
  gateInputs: readonly AgentArtifactReference[],
  requiredEvidence: readonly string[],
): GateReadiness {
  const reasons: string[] = [];
  const decision = gateResult?.draft.gateDecision;
  if (!gateResult) reasons.push('The Gate agent did not produce a result.');
  if (!decision) {
    reasons.push('The Gate agent did not produce a valid structured gate decision.');
  } else {
    if (decision.status !== 'pass') reasons.push(`Gate blocked review: ${decision.rationale}`);
    for (const missing of decision.missingEvidence) {
      reasons.push(`Gate reported missing evidence: ${missing}`);
    }
  }
  for (const pattern of requiredEvidence) {
    if (!gateInputs.some((artifact) => artifactMatches(pattern, artifact.type))) {
      reasons.push(`Required upstream artifact is absent: ${pattern}`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

function artifactContext(baseContext: string, artifacts: AgentArtifactReference[]) {
  const handoffs = artifacts.map((artifact) =>
    `\n\n## Handoff from ${artifact.producedBy}: ${artifact.name}\nType: ${artifact.type}\nContent address: ${artifact.contentAddress}\nForgejo: ${artifact.repositoryUrl ?? 'not repository-backed'}\nDigest: ${artifact.contentHash} · ${artifact.byteLength} bytes`,
  ).join('');
  return `${baseContext}${handoffs}`.slice(-24_000);
}

export interface HumanGuidanceEntry {
  key: string;
  kind: 'question_answer' | 'agent_comment' | 'artifact_feedback' | 'overall_direction' | 'agent_feedback';
  summary: string;
  role?: AgentRole;
}

export function mergeHumanGuidance(
  current: readonly HumanGuidanceEntry[],
  stored: readonly HumanGuidanceEntry[],
): HumanGuidanceEntry[] {
  const merged = new Map(current.map((entry) => [entry.key, entry]));
  for (const entry of stored) merged.set(entry.key, entry);
  return [...merged.values()];
}

export function requiredHumanDecisionIds(
  guidance: readonly HumanGuidanceEntry[],
  role?: AgentRole,
): string[] {
  return [...new Set(guidance
    .filter((entry) => entry.kind === 'question_answer' || !entry.role || entry.role === role)
    .map((entry) => entry.key))];
}

export function mergeAgentArtifactContext(
  current: readonly AgentArtifactReference[],
  prior: readonly AgentArtifactReference[],
): AgentArtifactReference[] {
  const merged = new Map<string, AgentArtifactReference>();
  for (const artifact of [...current, ...prior]) {
    if (!merged.has(artifact.id)) merged.set(artifact.id, artifact);
  }
  return [...merged.values()];
}

export function agentArtifactContextPatterns(step: DeliveryAgentDefinition): string[] {
  return [...new Set([step.artifactType, ...step.consumes, ...step.produces])];
}

export function repositoryAndHumanContext(
  project: Project,
  iteration: ProjectIteration,
  role: AgentRole,
  guidance: readonly HumanGuidanceEntry[],
): string {
  const repository = [
    '## Repository workspace',
    `Repository: ${project.repositoryUrl ?? 'not connected'}`,
    `Owner/name: ${project.repositoryOwner ?? 'unknown'}/${project.repositoryName ?? 'unknown'}`,
    'Base branch: main',
    `Iteration branch: ${iteration.branchName ?? `iteration-${iteration.number}-agents`}`,
    `Tracking issue: ${iteration.issueNumber ? `#${iteration.issueNumber}` : 'pending'}`,
    `Pull request: ${iteration.pullRequestUrl ?? 'not opened yet'}`,
  ].join('\n');
  const relevant = guidance.filter((entry) => !entry.role || entry.role === role);
  const direction = relevant.length === 0
    ? '## Human direction\nNo additional human direction has been supplied for this order.'
    : `## Human direction\n${relevant.map((entry) => `- [${entry.kind}] ${entry.summary}`).join('\n')}`;
  return `${repository}\n\n${direction}`;
}

export function agentOrderContext(
  baseContext: string,
  project: Project,
  iteration: ProjectIteration,
  role: AgentRole,
  artifacts: AgentArtifactReference[],
  guidance: readonly HumanGuidanceEntry[],
  forgejoIssuesContext = '',
): string {
  const artifactHistory = artifactContext(baseContext, artifacts).slice(-16_000);
  const liveControlContext = repositoryAndHumanContext(project, iteration, role, guidance).slice(-5_000);
  const issues = forgejoIssuesContext.trim().slice(-6_000);
  return [artifactHistory, liveControlContext, issues].filter(Boolean).join('\n\n').slice(-24_000);
}

export function reviewAdvancesIteration(
  decision: IterationReview['decision'],
  mergeConfirmed: boolean,
): boolean {
  return (decision === 'approved' || decision === 'approve') && mergeConfirmed;
}

export interface AcceptedIterationReview {
  review: IterationReview;
  idempotencyKey: string;
}

export interface ReviewCandidateState {
  checkpoint?: ReviewCheckpoint;
  proposal?: IterationReviewProposal;
  acceptedReview?: AcceptedIterationReview;
  invalidated: boolean;
  affectedRoles: AgentRole[];
}

/**
 * Human guidance supersedes the entire review candidate, including an
 * approval signal that may already have been accepted for its checkpoint.
 */
export function invalidateReviewCandidateForHumanGuidance(
  candidate: ReviewCandidateState,
  affectedRole?: AgentRole,
): ReviewCandidateState {
  const hasActiveCandidate = Boolean(
    candidate.checkpoint
    || candidate.proposal
    || candidate.acceptedReview,
  );
  const affectedRoles = affectedRole && !candidate.affectedRoles.includes(affectedRole)
    ? [...candidate.affectedRoles, affectedRole]
    : [...candidate.affectedRoles];
  if (!hasActiveCandidate && !candidate.invalidated) {
    return { ...candidate, affectedRoles };
  }
  return {
    checkpoint: undefined,
    proposal: undefined,
    acceptedReview: undefined,
    invalidated: true,
    affectedRoles,
  };
}

function isReviewSubmission(value: IterationReview | IterationReviewSubmission): value is IterationReviewSubmission {
  return typeof value === 'object' && value !== null && 'review' in value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, canonicalize(entry)]));
}

function legacyReviewIdempotencyKey(review: IterationReview): string {
  return `legacy:${JSON.stringify(canonicalize(review))}`;
}

function isApproval(review: IterationReview): boolean {
  return review.decision === 'approve' || review.decision === 'approved';
}

function approvalAttestsToCheckpoint(checkpoint: ReviewCheckpoint, review: IterationReview): boolean {
  // Checkpoints without a revision belong to histories created before the
  // revision-bound preview patch and retain their legacy review semantics.
  if (!checkpoint.previewRevision || !isApproval(review)) return true;
  // Revision-only checkpoints were emitted before image-digest attestation.
  // Preserve their replay semantics without allowing newly-created checkpoints
  // to omit the digest (createReviewCheckpoint always includes it by default).
  if (!checkpoint.previewImageDigest && !checkpoint.previewExpiresAt) {
    const legacyAttestation = review.previewAttestation as { revision?: unknown; triedAt?: unknown } | null | undefined;
    return legacyAttestation?.revision === checkpoint.previewRevision
      && typeof legacyAttestation.triedAt === 'string'
      && !Number.isNaN(Date.parse(legacyAttestation.triedAt));
  }
  if (!checkpoint.previewImageDigest || !checkpoint.previewExpiresAt) return false;
  const attestation = previewAttestationSchema.safeParse(review.previewAttestation);
  return attestation.success
    && attestation.data.revision === checkpoint.previewRevision
    && attestation.data.imageDigest === checkpoint.previewImageDigest
    && Date.parse(attestation.data.triedAt) <= Date.parse(checkpoint.previewExpiresAt);
}

export function createReviewCheckpoint(
  iteration: ProjectIteration,
  reviewSequence: number,
  preview?: PreviewDeploymentResult,
  bindImageDigest = true,
): ReviewCheckpoint {
  if (!iteration.pullRequestNumber) throw new Error('Iteration review requires a pull request checkpoint.');
  const revisionBinding = preview
    ? `:revision:${preview.revision}${bindImageDigest ? `:image:${preview.imageDigest}` : ''}`
    : '';
  return {
    iterationId: iteration.id,
    iterationNumber: iteration.number,
    pullRequestNumber: iteration.pullRequestNumber,
    reviewToken: `${iteration.id}:pr:${iteration.pullRequestNumber}${revisionBinding}:review:${reviewSequence}`,
    ...(preview ? {
      previewRevision: preview.revision,
      ...(bindImageDigest ? { previewImageDigest: preview.imageDigest } : {}),
      ...(bindImageDigest ? { previewExpiresAt: preview.expiresAt } : {}),
      previewUrl: preview.publicUrl,
    } : {}),
  };
}

export function acceptIterationReviewSubmission(
  checkpoint: ReviewCheckpoint | undefined,
  submission: IterationReview | IterationReviewSubmission,
  processedIdempotencyKeys: ReadonlySet<string>,
): AcceptedIterationReview | undefined {
  if (!checkpoint) return undefined;
  if (isReviewSubmission(submission)) {
    if (!submission.idempotencyKey.trim()
      || submission.iterationId !== checkpoint.iterationId
      || submission.reviewToken !== checkpoint.reviewToken
      || processedIdempotencyKeys.has(submission.idempotencyKey)
      || !approvalAttestsToCheckpoint(checkpoint, submission.review)) return undefined;
    return { review: submission.review, idempotencyKey: submission.idempotencyKey };
  }
  const idempotencyKey = legacyReviewIdempotencyKey(submission);
  if (checkpoint.previewRevision && isApproval(submission)) return undefined;
  if (processedIdempotencyKeys.has(idempotencyKey)
    || !approvalAttestsToCheckpoint(checkpoint, submission)) return undefined;
  return { review: submission, idempotencyKey };
}

function downstreamRoles(role: AgentRole): AgentRole[] {
  return iterationAgentGraph.filter((candidate) => candidate.dependsOn.some((dependency) => dependency === role)).map((candidate) => candidate.role);
}

/**
 * Expands a meaningful change only through roles whose obligations can be
 * affected by it. Gate always re-evaluates the resulting evidence boundary;
 * an empty seed set deliberately falls back to the full mandatory organism.
 */
export function reactiveIterationRoles(seedRoles: readonly AgentRole[]): AgentRole[] {
  const mandatoryRoles = iterationAgentGraph.map((definition) => definition.role);
  const mandatory = new Set<AgentRole>(mandatoryRoles);
  const selected = new Set(seedRoles.filter((role) => mandatory.has(role)));
  if (selected.size === 0) return mandatoryRoles;
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of iterationAgentGraph) {
      if (selected.has(definition.role)
        || !definition.dependsOn.some((dependency) => selected.has(dependency))) continue;
      selected.add(definition.role);
      changed = true;
    }
  }
  selected.add('gate');
  return mandatoryRoles.filter((role) => selected.has(role));
}

export function targetedReviewReactivationRoles(
  overallDirection: string,
  agentRoles: readonly AgentRole[],
  artifactOwnerRoles: readonly AgentRole[],
): AgentRole[] {
  if (overallDirection.trim()) return iterationAgentGraph.map((definition) => definition.role);
  return reactiveIterationRoles([...new Set([...agentRoles, ...artifactOwnerRoles])]);
}

export function targetedArtifactFeedbackOwnerRoles(
  feedback: readonly { artifactId: string; feedback: string }[],
  artifactOwners: ReadonlyMap<string, AgentRole>,
): AgentRole[] {
  return [...new Set(feedback.flatMap((entry) => {
    if (!entry.feedback.trim()) return [];
    const owner = artifactOwners.get(entry.artifactId);
    return owner ? [owner] : [];
  }))];
}

export type ReviewProposalWorkflowAction = 'open_review' | 'continue_autonomously' | 'wait_for_human';

/** Keep a Manager continuation distinct from a genuinely human-owned cutoff. */
export function reviewProposalWorkflowAction(
  recommendation: IterationReviewProposal['recommendation'],
): ReviewProposalWorkflowAction {
  if (recommendation === 'send_for_human_review') return 'open_review';
  if (recommendation === 'continue_iteration') return 'continue_autonomously';
  return 'wait_for_human';
}

export function reviewProposalRequiresWakeup(
  recommendation: IterationReviewProposal['recommendation'],
  autonomousContinuationEnabled: boolean,
): boolean {
  return !autonomousContinuationEnabled
    || reviewProposalWorkflowAction(recommendation) === 'wait_for_human';
}

export interface ReactiveIterationSafetyState {
  iterationNumber: number;
  executionRounds: number;
  noProgressRounds: number;
  lastProgressFingerprint?: string;
}

export interface ReactiveContinuationSafetyLimits {
  maxExecutionRounds: number;
  maxNoProgressRounds: number;
}

export type ReactiveContinuationSafetyReason = 'execution_round_limit' | 'no_progress_limit';

export interface ReactiveContinuationSafetyAssessment {
  state: ReactiveIterationSafetyState;
  exhausted: boolean;
  reason?: ReactiveContinuationSafetyReason;
}

/** Counts every outer organism pass and resets only at a real iteration boundary. */
export function beginReactiveIterationRound(
  current: ReactiveIterationSafetyState | undefined,
  iterationNumber: number,
): ReactiveIterationSafetyState {
  if (!current || current.iterationNumber !== iterationNumber) {
    return { iterationNumber, executionRounds: 1, noProgressRounds: 0 };
  }
  return { ...current, executionRounds: current.executionRounds + 1 };
}

function compareCanonicalStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Uses only durable readiness evidence. Attempt counters, token use, cost, and
 * prose rationales are deliberately excluded because they can change while
 * the iteration remains substantively stuck.
 */
export function iterationReviewProgressFingerprint(proposal: IterationReviewProposal): string {
  const findings = proposal.openFindings
    .map((finding) => ({
      findingId: finding.findingId ?? null,
      severity: finding.severity,
      summary: finding.summary,
      disposition: finding.disposition,
    }))
    .sort((left, right) => compareCanonicalStrings(JSON.stringify(left), JSON.stringify(right)));
  const agentPositions = Object.entries(proposal.agentPositions)
    .sort(([left], [right]) => compareCanonicalStrings(left, right));
  return JSON.stringify({
    includedRevision: proposal.includedRevision,
    objectiveStatus: proposal.objectiveStatus,
    completedOutcomes: [...proposal.completedOutcomes].sort(compareCanonicalStrings),
    openFindings: findings,
    agentPositions,
    knownLimitations: [...proposal.knownLimitations].sort(compareCanonicalStrings),
    activeMutationCount: proposal.budgetSnapshot.activeMutationCount,
  });
}

/** Stops an autonomous continuation before it can schedule an unbounded next pass. */
export function assessReactiveContinuationSafety(
  current: ReactiveIterationSafetyState,
  proposal: IterationReviewProposal,
  limits: ReactiveContinuationSafetyLimits,
): ReactiveContinuationSafetyAssessment {
  const progressFingerprint = iterationReviewProgressFingerprint(proposal);
  const noProgressRounds = current.lastProgressFingerprint === undefined
    || current.lastProgressFingerprint !== progressFingerprint
    ? 0
    : current.noProgressRounds + 1;
  const state = {
    ...current,
    noProgressRounds,
    lastProgressFingerprint: progressFingerprint,
  };
  const reason: ReactiveContinuationSafetyReason | undefined = current.executionRounds >= limits.maxExecutionRounds
    ? 'execution_round_limit'
    : noProgressRounds >= limits.maxNoProgressRounds
      ? 'no_progress_limit'
      : undefined;
  return { state, exhausted: reason !== undefined, ...(reason ? { reason } : {}) };
}

export function reactiveContinuationSafetyDecision(
  state: ReactiveIterationSafetyState,
  reason: ReactiveContinuationSafetyReason,
  proposal: IterationReviewProposal,
): DynamicHumanDecisionRequest {
  const notReadyRoles = Object.entries(proposal.agentPositions)
    .filter(([, position]) => position === 'not_ready')
    .map(([role]) => role)
    .sort(compareCanonicalStrings);
  const limitDescription = reason === 'execution_round_limit'
    ? `${state.executionRounds} execution rounds have run in this iteration`
    : `${state.noProgressRounds} consecutive continuation rounds produced no durable readiness change`;
  return {
    decisionKey: `iteration.${state.iterationNumber}.reactive-safety.r${state.executionRounds}.np${state.noProgressRounds}`,
    question: `The autonomous iteration safety limit was reached because ${limitDescription}. How should Orchestra proceed?`,
    context: `Manager still recommends continuing. Roles currently not ready: ${notReadyRoles.join(', ') || 'none identified'}. The next execution round will not begin without a human decision.`,
    options: [
      {
        value: 'continue_bounded_round',
        label: 'Continue one round',
        description: 'Authorize one additional bounded organism pass, after which the safety guard evaluates again.',
      },
      {
        value: 'reduce_scope',
        label: 'Reduce scope',
        description: 'Direct the Manager to narrow this iteration before agents continue.',
      },
    ],
    allowCustomAnswer: true,
    allowAgentDecide: false,
  };
}

function describeModelFailure(error: unknown): string {
  let current: unknown = error;
  let message = 'The local model worker is unavailable.';

  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const candidate = Reflect.get(current, 'message');
    if (typeof candidate === 'string' && candidate !== 'Activity task failed') message = candidate;
    current = Reflect.get(current, 'cause');
  }

  return message;
}

export const approveBrief = defineSignal('approveBrief');
export const projectState = defineQuery<string>('projectState');
export const projectDetails = defineQuery<Project>('projectDetails');
export const projectReady = defineSignal('projectReady');
export const reviewIteration = defineSignal<[IterationReview | IterationReviewSubmission]>('reviewIteration');
export const getReviewCheckpoint = defineQuery<ReviewCheckpoint | undefined>('getReviewCheckpoint');
export const resumeProject = defineSignal<[AgentExecutionScope?]>('resumeProject');
export const enableDurableHumanGuidance = defineSignal('enableDurableHumanGuidance');
export const answerAgentQuestion = defineSignal<[{
  questionId: string;
  answer: AgentQuestionAnswerInput;
}]>('answerAgentQuestion');
const answerAgentQuestionAndWait = defineUpdate<void, [{
  questionId: string;
  answer: AgentQuestionAnswerInput;
}]>('answerAgentQuestionAndWait');
export const commentOnAgent = defineSignal<[AgentCommentInput]>('commentOnAgent');
export const commentOnArtifact = defineSignal<[ArtifactFeedbackInput]>('commentOnArtifact');

export async function createProjectWorkflow(brief: ProjectBrief): Promise<Project> {
  let ready = false;
  setHandler(projectReady, () => { ready = true; });
  const project = await projectActivities().createProject(brief);
  await startChild(projectWorkflow, {
    workflowId: `project/${project.id}`,
    args: [project, workflowInfo().workflowId],
    parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
  });
  await condition(() => ready);
  return project;
}

export interface ProjectWorkflowContinuation {
  iterationNumber: number;
  executionRound: number;
  nextRoundRoles?: AgentRole[];
  reactiveIterationSafety?: ReactiveIterationSafetyState;
  reviewSequence: number;
  resumeVersion: number;
  context: string;
  state: string;
  durableHumanGuidanceEnabled: boolean;
  persistentActors: boolean;
  actorMailboxDelivery: boolean;
  humanGuidanceActorMailbox: boolean;
  splitAgentTaskQueues: boolean;
}

export function boundedProjectWorkflowContinuation(
  continuation: ProjectWorkflowContinuation,
): ProjectWorkflowContinuation {
  return {
    ...continuation,
    ...(continuation.nextRoundRoles
      ? { nextRoundRoles: [...continuation.nextRoundRoles] }
      : { nextRoundRoles: undefined }),
    context: continuation.context.slice(-24_000),
  };
}

export function continuationRoundRoles(
  nextRoundRoles: readonly AgentRole[] | undefined,
  pendingReviewReworkRoles: readonly AgentRole[],
): AgentRole[] | undefined {
  if (pendingReviewReworkRoles.length === 0) {
    return nextRoundRoles ? [...nextRoundRoles] : undefined;
  }
  return reactiveIterationRoles([
    ...(nextRoundRoles ?? []),
    ...pendingReviewReworkRoles,
  ]);
}

export async function projectWorkflow(
  project: Project,
  creatorWorkflowId?: string,
  continuation?: ProjectWorkflowContinuation,
): Promise<void> {
  let pendingReview: IterationReview | undefined;
  let pendingReviewIdempotencyKey: string | undefined;
  let activeReviewCheckpoint: ReviewCheckpoint | undefined;
  let activeReviewProposal: IterationReviewProposal | undefined;
  let reviewCandidateInvalidated = false;
  let pendingReviewReworkRoles: AgentRole[] = [];
  let reviewSequence = continuation?.reviewSequence ?? 0;
  const processedReviewIdempotencyKeys = new Set<string>();
  let resumeVersion = continuation?.resumeVersion ?? 0;
  const humanDecisionCoordinator = new AgentHumanDecisionCoordinator();
  let decisionReconciliationRequested = true;
  let durableHumanGuidanceEnabled = continuation?.durableHumanGuidanceEnabled ?? false;
  let state = continuation?.state ?? 'discovering';
  const agentResponses = new Map<string, AgentExecutionResponse>();
  type PendingHumanInput =
    | { kind: 'question_answer'; value: { questionId: string; answer: AgentQuestionAnswerInput } }
    | { kind: 'agent_comment'; value: AgentCommentInput }
    | { kind: 'artifact_feedback'; value: ArtifactFeedbackInput };
  const pendingHumanInputs: PendingHumanInput[] = [];
  let humanGuidance: HumanGuidanceEntry[] = [];
  const receiveReview = (submission: IterationReview | IterationReviewSubmission) => {
    if (pendingReview) return;
    const accepted = acceptIterationReviewSubmission(
      activeReviewCheckpoint,
      submission,
      processedReviewIdempotencyKeys,
    );
    if (!accepted) return;
    pendingReview = accepted.review;
    pendingReviewIdempotencyKey = accepted.idempotencyKey;
  };
  const invalidateActiveReviewCandidate = (affectedRole?: AgentRole) => {
    
    const invalidated = invalidateReviewCandidateForHumanGuidance({
      checkpoint: activeReviewCheckpoint,
      proposal: activeReviewProposal,
      acceptedReview: pendingReview && pendingReviewIdempotencyKey
        ? { review: pendingReview, idempotencyKey: pendingReviewIdempotencyKey }
        : undefined,
      invalidated: reviewCandidateInvalidated,
      affectedRoles: pendingReviewReworkRoles,
    }, affectedRole);
    pendingReviewReworkRoles = invalidated.affectedRoles;
    if (!invalidated.invalidated) return;
    activeReviewCheckpoint = invalidated.checkpoint;
    activeReviewProposal = invalidated.proposal;
    pendingReview = invalidated.acceptedReview?.review;
    pendingReviewIdempotencyKey = invalidated.acceptedReview?.idempotencyKey;
    reviewCandidateInvalidated = true;
    state = 'reviewing';
  };
  setHandler(approveBrief, () => { receiveReview({ decision: 'approved', feedback: '' }); });
  setHandler(reviewIteration, receiveReview);
  setHandler(resumeProject, (scope) => {
    decisionReconciliationRequested = true;
    resumeVersion += 1;
    humanDecisionCoordinator.resume(scope);
  });
  setHandler(enableDurableHumanGuidance, () => {
    durableHumanGuidanceEnabled = true;
    decisionReconciliationRequested = true;
    resumeVersion += 1;
    humanDecisionCoordinator.requestQuestionRecheck();
  });
  setHandler(answerAgentQuestion, (value) => {
    pendingHumanInputs.push({ kind: 'question_answer', value });
    decisionReconciliationRequested = true;
    resumeVersion += 1;
    humanDecisionCoordinator.noteQuestionInput(value.questionId);
  });
  setHandler(answerAgentQuestionAndWait, async (value) => {
    pendingHumanInputs.push({ kind: 'question_answer', value });
    decisionReconciliationRequested = true;
    resumeVersion += 1;
    humanDecisionCoordinator.noteQuestionInput(value.questionId);
    // Unlike the legacy fire-and-forget Signal, an Update does not acknowledge
    // the HTTP request until the durable database answer exists.
    await flushHumanInputs();
  });
  setHandler(commentOnAgent, (value) => {
    if (value.projectId !== project.id) return;
    pendingHumanInputs.push({ kind: 'agent_comment', value });
    invalidateActiveReviewCandidate(value.agentRole);
    resumeVersion += 1;
  });
  setHandler(commentOnArtifact, (value) => {
    pendingHumanInputs.push({ kind: 'artifact_feedback', value });
    invalidateActiveReviewCandidate();
    resumeVersion += 1;
  });
  setHandler(agentExecutionCompleted, (response) => { agentResponses.set(response.orderId, response); });
  setHandler(projectState, () => state);
  setHandler(projectDetails, () => project);
  setHandler(getReviewCheckpoint, () => activeReviewCheckpoint);

  if (!continuation && creatorWorkflowId) {
    await getExternalWorkflowHandle(creatorWorkflowId).signal(projectReady);
  }

  if (!continuation) {
    project = await projectActivities().connectProjectRepository(project);
  }

  async function loadDurableHumanGuidance(): Promise<HumanGuidanceEntry[]> {
    let loaded: HumanGuidanceEntry[] = [];
    let afterKey: string | undefined;
    do {
      const result = await projectActivities().getProjectHumanGuidance(project.id, {
        ...(afterKey ? { afterKey } : {}),
        limit: 50,
      });
      const page = Array.isArray(result) ? { entries: result } : result;
      loaded = mergeHumanGuidance(loaded, page.entries);
      afterKey = page.nextCursor;
    } while (afterKey);
    return loaded;
  }

  async function flushHumanInputs(): Promise<void> {
    if (decisionReconciliationRequested) {
      await projectActivities().reconcileAgentQuestionDecisions(project.id);
      decisionReconciliationRequested = false;
    }
    while (pendingHumanInputs.length > 0) {
      const item = pendingHumanInputs.shift()!;
      if (item.kind === 'question_answer') {
        humanDecisionCoordinator.beginQuestionPersistence(item.value.questionId);
        const answered = await projectActivities().persistAgentQuestionAnswer(project.id, item.value.questionId, item.value.answer);
        humanDecisionCoordinator.markQuestionAnswered(item.value.questionId);
        let answer: string;
        if (item.value.answer.resolution === 'custom') {
          answer = item.value.answer.answer;
        } else if (item.value.answer.resolution === 'agent_decides') {
          answer = 'The human authorized the agent to decide within the existing scope.';
        } else {
          const optionId = item.value.answer.optionId;
          const selected = answered.options.find((option) => option.id === optionId);
          answer = selected
            ? `The human selected “${selected.label}”${selected.description ? ` — ${selected.description}` : ` (${selected.value})`}.`
            : 'The human selected one of the supplied options.';
        }
        humanGuidance.push({
          key: `question:${item.value.questionId}`,
          kind: 'question_answer',
          
          summary: `Answer to “${answered.question}”: ${answer}`,
        });
      } else if (item.kind === 'agent_comment') {
        const message = await projectActivities().persistAgentComment(item.value, 'actor_mailbox');
        await deliverActorMailboxMessage(message);
        humanGuidance.push({
          key: `agent-comment:${item.value.agentRole}:${humanGuidance.length}`,
          kind: 'agent_comment',
          role: item.value.agentRole,
          summary: item.value.body,
        });
      } else {
        const persistedFeedback = await projectActivities().persistArtifactFeedback(project.id, item.value, 'actor_mailbox');
        const role = typeof persistedFeedback === 'string' ? persistedFeedback : persistedFeedback.role;
        if (typeof persistedFeedback !== 'string') {
          await deliverActorMailboxMessage(persistedFeedback.message);
        }
        invalidateActiveReviewCandidate(role);
        humanGuidance.push({
          key: `artifact-feedback:${item.value.artifactId}:${humanGuidance.length}`,
          kind: 'artifact_feedback',
          role,
          summary: item.value.feedback || 'The human reviewed this artifact with no additional written feedback.',
        });
      }
    }
    {
      humanGuidance = mergeHumanGuidance(
        humanGuidance,
        await loadDurableHumanGuidance(),
      );
    }
  }

  async function waitForAgentQuestions(
    questionIds: readonly string[],
    scope?: AgentExecutionScope,
  ): Promise<void> {
    if (questionIds.length === 0) return;
    if (scope) humanDecisionCoordinator.registerQuestions(questionIds, scope);
    while (!humanDecisionCoordinator.areQuestionsLocallyAnswered(questionIds)) {
      // Capture before the Activity. An answer accepted or persisted while the
      // Activity is outstanding then advances this version, so condition() is
      // immediately true and cannot lose the wakeup.
      const capturedVersion = humanDecisionCoordinator.captureQuestionWait();
      if (await projectActivities().areAgentQuestionsAnswered(project.id, questionIds)) {
        humanDecisionCoordinator.markQuestionsAnswered(questionIds);
        return;
      }
      await condition(() => humanDecisionCoordinator.shouldRecheckQuestions(questionIds, capturedVersion));
      await flushHumanInputs();
    }
  }

  function captureRetry(scope: AgentExecutionScope): AgentRetryToken {
    return humanDecisionCoordinator.captureRetry(scope);
  }

  async function waitForRetry(
    scope: AgentExecutionScope,
    token: AgentRetryToken,
  ): Promise<void> {
    await condition(() => humanDecisionCoordinator.shouldRetry(scope, token));
  }

  const persistentActors = continuation?.persistentActors ?? true;
  const actorMailboxDelivery = continuation?.actorMailboxDelivery ?? true;
  const humanGuidanceActorMailbox = continuation?.humanGuidanceActorMailbox ?? true;
  const splitAgentTaskQueues = continuation?.splitAgentTaskQueues ?? true;
  if (persistentActors && !continuation) {
    await Promise.all(deliveryAgentGraph.map((definition) => startChild(persistentAgentRoleWorkflow, {
      workflowId: agentWorkflowId(project.id, definition.role),
      taskQueue: agentTaskQueue(definition.role),
      args: [{
        address: {
          projectId: project.id,
          role: definition.role,
          workflowId: agentWorkflowId(project.id, definition.role),
        },
        role: definition.role,
        mode: 'DORMANT',
        graphVersion: 1,
        projectStateVersion: 1,
      }],
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
    })));
  }

  async function deliverActorMailboxMessage(message: AgentMessage | undefined): Promise<void> {
    if (!message) throw new Error('Actor mailbox delivery requires a persisted protocol message.');
    // One multi-recipient envelope is signalled once to each addressed actor.
    // The store aggregates each recipient's monotonic delivery state.
    for (const recipient of message.recipients) {
      await getExternalWorkflowHandle(recipient.workflowId).signal(receiveAgentCommand, message);
      await projectActivities().transitionAgentMessage(
        message.projectId,
        message.idempotencyKey,
        'delivered',
        recipient.role,
      );
    }
  }

  async function recordAndDeliverAgentHandoff(
    iteration: ProjectIteration,
    role: AgentRole,
    artifacts: AgentArtifactReference[],
    handsOffTo: AgentRole[],
  ): Promise<void> {
    const message = await projectActivities().recordAgentHandoff(
        project,
        iteration,
        role,
        artifacts,
        handsOffTo,
        'actor_mailbox',
      );
    await deliverActorMailboxMessage(message);
  }

  async function completeAgentLedgerAfterHandoff(
    input: AgentWorkflowInput,
    result: AgentWorkflowExecutionResult,
    logicalOrderId: string,
  ): Promise<void> {

    const order = runtimeOrderForExecution(input, input.executionOperationId ?? logicalOrderId);
    await projectActivities().persistAgentExecutionLedger(
      input.project.id,
      input.iteration.id,
      input.role,
      order,
      'completed',
      result.draft.executionTrace,
      result.artifacts.map((artifact) => artifact.id),
      `iteration:${input.iteration.number}:${input.role}`,
      input.preview?.revision,
    );
  }

  async function blockAgentLedgerAfterParentVerification(
    input: AgentWorkflowInput,
    result: AgentWorkflowExecutionResult,
    logicalOrderId: string,
    failureReason: string,
  ): Promise<void> {

    const order = runtimeOrderForExecution(input, input.executionOperationId ?? logicalOrderId);
    const projection = parentVerificationBlockedLedgerProjection(result, failureReason);
    await projectActivities().persistAgentExecutionLedger(
      input.project.id,
      input.iteration.id,
      input.role,
      order,
      projection.status,
      projection.trace,
      projection.artifactIds,
      `iteration:${input.iteration.number}:${input.role}`,
      input.preview?.revision,
      projection.failureReason,
    );
  }

  async function recordAndDeliverAgentFailure(
    iterationNumber: number,
    role: AgentRole,
    failure: string,
  ): Promise<void> {
    const message = await projectActivities().recordAgentFailure(
        project.id,
        iterationNumber,
        role,
        failure,
        'actor_mailbox',
      );
    await deliverActorMailboxMessage(message);
  }

  async function executeThroughAgentActor(
    input: AgentWorkflowInput,
    orderId: string,
    executionCheckpoint?: DynamicArtifactExecutionCheckpoint,
  ): Promise<AgentWorkflowExecutionResult | AgentWorkflowWaitingResult | AgentWorkflowStoppedResult> {
    const recipientWorkflowId = agentWorkflowId(project.id, input.role);
    const order = runtimeOrderForExecution(input, orderId);
    
    const message: AgentExecutionCommand = {
      schemaVersion: '1.0',
      messageId: orderId,
      idempotencyKey: orderId,
      projectId: project.id,
      iterationId: input.iteration.id,
      correlationId: `iteration:${input.iteration.number}`,
      sender: {
        projectId: project.id,
        role: 'manager',
        workflowId: agentWorkflowId(project.id, 'manager'),
      },
      recipients: [{ projectId: project.id, role: input.role, workflowId: recipientWorkflowId }],
      kind: 'COMMAND',
      name: 'order.submit',
      priority: 'NORMAL',
      graphVersion: 1,
      projectStateVersion: input.iteration.number,
      senderStateVersion: input.iteration.number,
      authority: order.authority,
      payload: {
        orderId,
        order,
        input,
        replyWorkflowId: workflowInfo().workflowId,
        ...(executionCheckpoint ? { executionCheckpoint } : {}),
      },
      acknowledgementRequired: true,
      createdAt: new Date().toISOString(),
    };
    await projectActivities().persistAgentMessage(message);
    await getExternalWorkflowHandle(recipientWorkflowId).signal(receiveAgentCommand, message);
    await condition(() => agentResponses.has(orderId));
    const response = agentResponses.get(orderId)!;
    agentResponses.delete(orderId);
    if (response.error) throw new Error(response.error);
    if (response.waiting) return response.waiting;
    if (response.stopped) return response.stopped;
    if (!response.result) throw new Error(`${input.role} returned no workflow result.`);
    return response.result;
  }

  let iterationNumber = continuation?.iterationNumber ?? project.currentIteration;
  let executionRound = continuation?.executionRound ?? 0;
  let nextRoundRoles: AgentRole[] | undefined = continuation?.nextRoundRoles;
  let reactiveIterationSafety: ReactiveIterationSafetyState | undefined = continuation?.reactiveIterationSafety;
  let context = continuation?.context
    ?? `Intent: ${project.intent}\nAudience: ${project.audience}\nSuccess: ${project.success}\nConstraints: ${project.constraints.join('; ')}`;

  if (continuation) {
    humanGuidance = mergeHumanGuidance(
      humanGuidance,
      await loadDurableHumanGuidance(),
    );
  }

  async function continueProjectWorkflow(): Promise<never> {
    do {
      await flushHumanInputs();
      await condition(allHandlersFinished);
    } while (pendingHumanInputs.length > 0 || !allHandlersFinished());
    // No await may appear between this final quiescence check and the
    // Continue-As-New command. Late targeted guidance accepted during the
    // drain must affect the very next activation set.
    nextRoundRoles = continuationRoundRoles(nextRoundRoles, pendingReviewReworkRoles);
    pendingReviewReworkRoles = [];
    return continueAsNew<typeof projectWorkflow>(
      { ...project, currentIteration: iterationNumber },
      undefined,
      boundedProjectWorkflowContinuation({
        iterationNumber,
        executionRound,
        ...(nextRoundRoles ? { nextRoundRoles } : {}),
        ...(reactiveIterationSafety ? { reactiveIterationSafety } : {}),
        reviewSequence,
        resumeVersion,
        context,
        state,
        durableHumanGuidanceEnabled,
        persistentActors,
        actorMailboxDelivery,
        humanGuidanceActorMailbox,
        splitAgentTaskQueues,
      }),
    );
  }

  async function reopenReviewAfterHumanGuidance(currentIterationNumber: number): Promise<boolean> {
    
    if (!reviewCandidateInvalidated
      && pendingReviewReworkRoles.length === 0
      && pendingHumanInputs.length === 0) return false;
    await flushHumanInputs();
    if (!reviewCandidateInvalidated && pendingReviewReworkRoles.length === 0) return false;
    const supersedePersistedProposal = reviewCandidateInvalidated;
    activeReviewCheckpoint = undefined;
    activeReviewProposal = undefined;
    pendingReview = undefined;
    pendingReviewIdempotencyKey = undefined;
    state = 'reviewing';
    if (supersedePersistedProposal) {
      await projectActivities().supersedeIterationReviewProposal(project.id, currentIterationNumber);
    }
    await projectActivities().setProjectStatus(project.id, 'reviewing');
    await projectActivities().setIterationStatus(project.id, currentIterationNumber, 'active');
    // Capture guidance that arrived while the status transitions were in
    // flight before deciding which part of the organism must run again.
    await flushHumanInputs();
    {
      nextRoundRoles = reactiveIterationRoles(pendingReviewReworkRoles);
    }
    reviewCandidateInvalidated = false;
    pendingReviewReworkRoles = [];
    return true;
  }

  while (true) {
    executionRound += 1;
    {
      reactiveIterationSafety = beginReactiveIterationRound(reactiveIterationSafety, iterationNumber);
    }
    let iteration = await projectActivities().getIteration(project.id, iterationNumber);
    iteration = await projectActivities().prepareIterationRepository(project, iteration);
    await flushHumanInputs();
    let testPreview: PreviewDeploymentResult | undefined;
    let gateRationaleForProposal: string | undefined;

    const deployMandatoryPreview = async (): Promise<PreviewDeploymentResult> => {
      while (true) {
        try {
          const deployed = revisionBoundPreview(await validation.deployIterationPreview({ project, iteration }));
          project = await projectActivities().recordIterationPreview(project, iteration, deployed);
          return deployed;
        } catch (error) {
          const retryScope: AgentExecutionScope = {
            role: 'deployment',
            orderId: `${project.id}:i${iterationNumber}:preview`,
          };
          const retryToken = captureRetry(retryScope);
          state = 'blocked';
          await projectActivities().setProjectStatus(project.id, 'blocked');
          await projectActivities().setIterationStatus(project.id, iterationNumber, 'blocked');
          await projectActivities().recordPreviewUnavailable(project.id, iteration.number, describeModelFailure(error));
          await waitForRetry(retryScope, retryToken);
          await flushHumanInputs();
        }
      }
    };

    const verifyBuilderRevisionBeforeHandoff = async (): Promise<void> => {
      try {
        const deployed = revisionBoundPreview(await validation.deployIterationPreview({ project, iteration }));
        project = await projectActivities().recordIterationPreview(project, iteration, deployed);
        testPreview = deployed;
      } catch (error) {
        const failure = describeModelFailure(error);
        await projectActivities().recordPreviewUnavailable(project.id, iteration.number, failure);
        throw new Error(`Builder preflight failed before handoff: ${failure}`);
      }
    };

    const ensureIterationPreview = async (): Promise<PreviewDeploymentResult | undefined> => {
      if (!testPreview) {
        testPreview = await deployMandatoryPreview();
        await projectActivities().setIterationStatus(project.id, iterationNumber, 'active');
      }
      return testPreview;
    };

    const completed = new Map<AgentRole, AgentWorkflowExecutionResult>();
      const executionInputs = new Map<AgentRole, AgentArtifactReference[]>();
      let gateLedgerContext: { input: AgentWorkflowInput; logicalOrderId: string } | undefined;
      const selectedRoundRoles = nextRoundRoles;
      const includeCurrentIterationContext = selectedRoundRoles !== undefined;
      const scheduledRoles = new Set(selectedRoundRoles ?? iterationAgentGraph.map((step) => step.role));
      nextRoundRoles = undefined;
      const remaining = new Set<AgentRole>(scheduledRoles);
      const running = new Map<AgentRole, Promise<readonly [AgentRole, AgentWorkflowExecutionResult | { collaborationCalls: AgentRole[] }]>>();
      const collaborationRevisits = new Map<AgentRole, number>();
      const maxCollaborationRevisits = 2;

      while (remaining.size > 0 || running.size > 0) {
        await flushHumanInputs();
        const ready = iterationAgentGraph.filter((step) =>
          remaining.has(step.role)
          && (
            collaborationRevisits.has(step.role)
            || step.dependsOn.every((dependency) => !scheduledRoles.has(dependency) || completed.has(dependency))
          ),
        );
        if (ready.length > 0) {
          if (ready.some((step) => step.role === 'test'
            || step.role === 'reviewer' || step.role === 'gate')) {
            await ensureIterationPreview();
          }
          const projectStatus = ready.some((step) => step.projectStatus === 'building') ? 'building'
            : ready.some((step) => step.projectStatus === 'reviewing') ? 'reviewing'
              : ready.some((step) => step.projectStatus === 'planning') ? 'planning' : 'defining';
          state = projectStatus;
          await projectActivities().setProjectStatus(project.id, projectStatus);

          for (const step of ready) {
            remaining.delete(step.role);
            const priorArtifacts = await projectActivities().getPriorAgentArtifacts(
                project.id,
                iterationNumber,
                agentArtifactContextPatterns(step),
                { includeCurrentIteration: true },
              );
            const inputArtifacts = mergeAgentArtifactContext(collectInputArtifacts(step, completed), priorArtifacts);
            executionInputs.set(step.role, inputArtifacts);
            running.set(step.role, (async () => {
              const builderPackagingLoop = step.role === 'builder';
              let packagingFailureContext = '';
              let packagingPlan: PackagingPlan | undefined = builderPackagingLoop
                ? await projectActivities().loadPackagingPlan(inputArtifacts)
                : undefined;
              let result: AgentWorkflowExecutionResult | undefined;
              let collaborationCalls: AgentRole[] = [];
              let agentAttempt = 0;
              let executionCheckpoint: DynamicArtifactExecutionCheckpoint | undefined;
              let verificationFailure: string | undefined;
              let artifactRevision = 0;
              const executionScope: AgentExecutionScope = {
                role: step.role,
                orderId: `${project.id}:i${iterationNumber}:run${executionRound}:${step.role}`,
              };
              while (!result) {
                try {
                  agentAttempt += 1;
                  await flushHumanInputs();
                  if (builderPackagingLoop && packagingPlan) {
                    // Re-upsert each attempt so template fixes (e.g. no push trigger)
                    // land even when Builder is retrying inside the same role order.
                    {
                      await projectActivities().materializePackagingWorkflow(project, iteration, packagingPlan);
                    }
                  }
                  let forgejoIssuesContext = '';
                  {
                    const loaded = await projectActivities().loadAgentForgejoIssues(project, step.role);
                    forgejoIssuesContext = loaded.context;
                  }
                  const orderContext = [
                    agentOrderContext(
                      context,
                      project,
                      iteration,
                      step.role,
                      inputArtifacts,
                      humanGuidance,
                      forgejoIssuesContext,
                    ),
                    packagingFailureContext,
                  ].filter(Boolean).join('\n\n');
                  const input: AgentWorkflowInput = {
                    project,
                    iteration,
                    role: step.role,
                    artifactType: step.artifactType,
                    artifactName: step.artifactName,
                    executionOperationId: executionScope.orderId,
                    artifactOperationId: `${executionScope.orderId}:artifact-revision:${artifactRevision}`,
                    revisionBoundAssurance: true,
                    deferCompletionLedger: true,
                    context: `${orderContext}${verificationFailure
                      ? `\n\n## Deterministic verification failure from the previous attempt\n${verificationFailure}\nCorrect this failure before returning the next complete artifact set.`
                      : ''}`,
                    inputArtifacts,
                    supervisedBy: [...step.supervisedBy],
                    handsOffTo: downstreamRoles(step.role),
                    requiredDecisionIds: requiredHumanDecisionIds(humanGuidance, step.role),
                    executionContextVersion: resumeVersion,
                    ...(testPreview && (step.role === 'test'
                      || step.role === 'reviewer' || step.role === 'gate')
                      ? { preview: testPreview }
                      : {}),
                  };
                  if (step.role === 'gate') {
                    gateLedgerContext = { input, logicalOrderId: executionScope.orderId };
                  }
                  const commandOrderId = `${executionScope.orderId}:attempt${agentAttempt}`;
                  const execution = await executeThroughAgentActor(
                    input,
                    commandOrderId,
                    executionCheckpoint,
                  );
                  if (isAgentWorkflowWaitingResult(execution)) {
                    executionCheckpoint = execution.executionCheckpoint;
                    await waitForAgentQuestions([execution.question.id], executionScope);
                    if (persistentActors) {
                      await getExternalWorkflowHandle(agentWorkflowId(project.id, step.role))
                        .signal(agentQuestionResolved, execution.question.id);
                    }
                    continue;
                  }
                  if (isAgentWorkflowStoppedResult(execution)) {
                    throw new Error(`${execution.status.toUpperCase()}: ${execution.reason}`);
                  }
                  let candidate = 'draft' in execution
                    ? execution
                    : { draft: execution, artifacts: [], questionIds: [] };
                  await waitForAgentQuestions(candidate.questionIds, executionScope);

                  {
                    const applied = await projectActivities().applyAgentForgejoIssueActions(
                      project,
                      iteration,
                      step.role,
                      candidate.draft,
                    );
                    collaborationCalls = applied.calledRoles;
                    if (step.role === 'manager') {
                      await projectActivities().materializeManagerWorkPackages(
                        project,
                        iteration,
                        candidate.artifacts,
                      );
                    }
                  }

                  if (builderPackagingLoop && packagingPlan) {
                    const checks = await packagingValidation.runPackagingBuildChecks({
                      project,
                      iteration,
                      plan: packagingPlan,
                    });
                    const evidenceArtifact = await projectActivities().recordPackagingEvidence(
                      project,
                      iteration,
                      packagingPlan,
                      checks.evidence,
                    );
                    candidate = {
                      ...candidate,
                      artifacts: [...candidate.artifacts, evidenceArtifact],
                    };
                    if (!packagingEvidenceSatisfiesPlan(checks.evidence, packagingPlan)) {
                      packagingFailureContext = formatPackagingSandboxResults(checks.evidence, packagingPlan);
                      verificationFailure = packagingFailureContext;
                      {
                        await projectActivities().rejectAgentArtifacts(
                          project.id,
                          candidate.artifacts.map((artifact) => artifact.id),
                        );
                        executionCheckpoint = undefined;
                        artifactRevision += 1;
                      }
                      if (agentAttempt >= DEFAULT_PACKAGING_MAX_ATTEMPTS) {
                        state = 'blocked';
                        await projectActivities().setProjectStatus(project.id, 'blocked');
                        await projectActivities().setIterationStatus(project.id, iterationNumber, 'blocked');
                        await recordAndDeliverAgentFailure(
                          iterationNumber,
                          'builder',
                          `Packaging checks failed after ${agentAttempt} attempts. ${checks.evidence.checks
                            .filter((check) => check.required && check.status !== 'passed')
                            .map((check) => check.summary)
                            .join(' ')}`,
                        );
                        const retryToken = captureRetry(executionScope);
                        await waitForRetry(executionScope, retryToken);
                        await flushHumanInputs();
                        agentAttempt = 0;
                      }
                      {
                        state = 'building';
                        await projectActivities().setProjectStatus(project.id, 'building');
                        await projectActivities().setIterationStatus(project.id, iterationNumber, 'active');
                      }
                      continue;
                    }
                  }

                  try {
                    if (step.role === 'builder') {
                      try {
                        await verifyBuilderRevisionBeforeHandoff();
                      } catch (error) {
                        {
                          await projectActivities().rejectAgentArtifacts(
                            project.id,
                            candidate.artifacts.map((artifact) => artifact.id),
                          );
                          executionCheckpoint = undefined;
                          artifactRevision += 1;
                        }
                        throw error;
                      }
                    }
                    await recordAndDeliverAgentHandoff(
                      iteration,
                      step.role,
                      candidate.artifacts,
                      downstreamRoles(step.role),
                    );
                    if (!defersCompletionUntilGateReadiness(step.role, true)) {
                      await completeAgentLedgerAfterHandoff(input, candidate, executionScope.orderId);
                    }
                  } catch (error) {
                    await blockAgentLedgerAfterParentVerification(
                      input,
                      candidate,
                      executionScope.orderId,
                      describeModelFailure(error),
                    );
                    throw error;
                  }
                  result = candidate;
                } catch (error) {
                  verificationFailure = describeModelFailure(error);
                  const retryToken = captureRetry(executionScope);
                  state = 'blocked';
                  await projectActivities().setProjectStatus(project.id, 'blocked');
                  await recordAndDeliverAgentFailure(iterationNumber, step.role, describeModelFailure(error));
                  // Human answers/comments can arrive while the role actor is
                  // still finishing. Persist them before capturing the blocked
                  // resume version so a later actor failure cannot strand an
                  // accepted UI submission in workflow memory.
                  {
                    await flushHumanInputs();
                  }
                  await waitForRetry(executionScope, retryToken);
                  await flushHumanInputs();
                }
              }
              return [step.role, { ...result, collaborationCalls }] as const;
            })());
          }
        }

        if (running.size === 0) throw new Error('The delivery graph contains an unresolved dependency cycle.');
        const [role, result] = await Promise.race(running.values());
        running.delete(role);
        const { collaborationCalls = [], ...execution } = result as AgentWorkflowExecutionResult & {
          collaborationCalls?: AgentRole[];
        };
        completed.set(role, execution);
        {
          for (const called of collaborationCalls) {
            if (!iterationAgentGraph.some((step) => step.role === called)) continue;
            if (running.has(called) || remaining.has(called)) continue;
            if (!completed.has(called)) {
              remaining.add(called);
              continue;
            }
            const revisits = collaborationRevisits.get(called) ?? 0;
            if (revisits >= maxCollaborationRevisits) continue;
            collaborationRevisits.set(called, revisits + 1);
            completed.delete(called);
            remaining.add(called);
          }
        }
      }
      const gate = completed.get('gate');
      if (gate) context = artifactContext(context, gate.artifacts);
      const gateDefinition = iterationAgentGraph.find((step) => step.role === 'gate');
      const gateReadiness = evaluateGateReadiness(
        gate,
        executionInputs.get('gate') ?? [],
        gateDefinition?.consumes ?? [],
      );
      if (!gateReadiness.ready) {
        if (gate && gateLedgerContext) {
          await blockAgentLedgerAfterParentVerification(
            gateLedgerContext.input,
            gate,
            gateLedgerContext.logicalOrderId,
            gateReadiness.reasons.join(' '),
          );
        }
        const retryScope: AgentExecutionScope = {
          role: 'gate',
          orderId: `${project.id}:i${iterationNumber}:run${executionRound}:gate-readiness`,
        };
        const retryToken = captureRetry(retryScope);
        state = 'blocked';
        await projectActivities().setProjectStatus(project.id, 'blocked');
        await projectActivities().setIterationStatus(project.id, iterationNumber, 'blocked');
        await recordAndDeliverAgentFailure(
          iterationNumber,
          'gate',
          gateReadiness.reasons.join(' '),
        );
        await waitForRetry(retryScope, retryToken);
        await flushHumanInputs();
        continue;
      }
      if (gate && gateLedgerContext) {
        await completeAgentLedgerAfterHandoff(
          gateLedgerContext.input,
          gate,
          gateLedgerContext.logicalOrderId,
        );
      }
      gateRationaleForProposal = gate?.draft.gateDecision?.rationale;

    if (await reopenReviewAfterHumanGuidance(iterationNumber)) continue;

    iteration = await projectActivities().prepareIterationReview(project, iterationNumber);
    if (!iteration.pullRequestNumber) throw new Error('Iteration review requires a pull request checkpoint.');
    // Resolve once more before review. New histories keep Test, Reviewer, and
    // Gate evidence in the ledger so this revision must remain the frozen
    // candidate; legacy histories may still have advanced the branch head.
    const reviewPreview = await deployMandatoryPreview();
    if (reviewPreview
      && reviewPreview.revision !== testPreview?.revision) {
      const retryScope: AgentExecutionScope = {
        role: 'gate',
        orderId: `${project.id}:i${iterationNumber}:candidate-revision-changed`,
      };
      const retryToken = captureRetry(retryScope);
      state = 'blocked';
      await projectActivities().setProjectStatus(project.id, 'blocked');
      await projectActivities().setIterationStatus(project.id, iterationNumber, 'blocked');
      await recordAndDeliverAgentFailure(
        iterationNumber,
        'gate',
        `The candidate revision changed after Test and Gate evaluated ${testPreview?.revision ?? 'no immutable revision'}; the current head is ${reviewPreview.revision}.`,
      );
      await waitForRetry(retryScope, retryToken);
      await flushHumanInputs();
      continue;
    }
    if (reviewPreview) {
      while (true) {
        try {
          const recording = await validation.captureUserFlow({ project, iteration, preview: reviewPreview });
          if (recording.revision !== reviewPreview.revision) {
            throw new Error('Final review evidence did not attest to the proposed preview revision.');
          }
          await projectActivities().recordUserFlowMedia(
              project,
              iteration,
              recording,
              reviewPreview,
              `${project.id}:i${iterationNumber}:final-review-media:${reviewPreview.revision}`,
            );
          break;
        } catch (error) {
          const retryScope: AgentExecutionScope = {
            role: 'test',
            orderId: `${project.id}:i${iterationNumber}:final-review-evidence`,
          };
          const retryToken = captureRetry(retryScope);
          state = 'blocked';
          await projectActivities().setProjectStatus(project.id, 'blocked');
          await projectActivities().setIterationStatus(project.id, iterationNumber, 'blocked');
          await recordAndDeliverAgentFailure(
            iterationNumber,
            'test',
            `Final revision evidence failed: ${describeModelFailure(error)}`,
          );
          await waitForRetry(retryScope, retryToken);
          await flushHumanInputs();
        }
      }
    }
    await projectActivities().setIterationStatus(project.id, iterationNumber, 'awaiting_review');
    if (await reopenReviewAfterHumanGuidance(iterationNumber)) continue;
    reviewSequence += 1;
    activeReviewCheckpoint = createReviewCheckpoint(iteration, reviewSequence, reviewPreview, true);
    activeReviewProposal = undefined;
    let reviewProposal: IterationReviewProposal | undefined;
    if (activeReviewCheckpoint.previewRevision) {
      reviewProposal = await projectActivities().recordIterationReviewProposal(
        project.id,
        iterationNumber,
        activeReviewCheckpoint.previewRevision,
        reviewSequence,
        gateRationaleForProposal,
      );
      if (!reviewCandidateInvalidated) activeReviewProposal = reviewProposal;
    }
    if (reviewCandidateInvalidated) {
      await reopenReviewAfterHumanGuidance(iterationNumber);
      continue;
    }
    if (reviewProposal
      && reviewProposal.recommendation !== 'send_for_human_review') {
      const cutoffResumeVersion = resumeVersion;
      const proposalAction = reviewProposalWorkflowAction(reviewProposal.recommendation);
      let continuationSafety: ReactiveContinuationSafetyAssessment | undefined;
      if (reviewProposal.recommendation === 'continue_iteration') {
        if (!reactiveIterationSafety) {
          throw new Error('Reactive continuation safety state was not initialized for this iteration.');
        }
        continuationSafety = assessReactiveContinuationSafety(
          reactiveIterationSafety,
          reviewProposal,
          {
            maxExecutionRounds: defaultDynamicExecutionLimits.maxPlanningRounds,
            maxNoProgressRounds: defaultDynamicExecutionLimits.maxNoProgressRounds,
          },
        );
        reactiveIterationSafety = continuationSafety.state;
      }
      {
        const notReadyRoles = iterationAgentGraph
          .map((definition) => definition.role)
          .filter((role) => reviewProposal.agentPositions[role] === 'not_ready');
        nextRoundRoles = reactiveIterationRoles(notReadyRoles);
      }
      activeReviewCheckpoint = undefined;
      activeReviewProposal = undefined;
      state = proposalAction === 'wait_for_human' || continuationSafety?.exhausted
        ? 'waiting_on_human'
        : 'reviewing';
      await projectActivities().setProjectStatus(project.id, 'reviewing');
      await projectActivities().setIterationStatus(project.id, iterationNumber, 'active');
      if (continuationSafety?.exhausted) {
        if (!continuationSafety.reason) {
          throw new Error('An exhausted reactive continuation must identify its safety limit.');
        }
        const safetyRequest = reactiveContinuationSafetyDecision(
          continuationSafety.state,
          continuationSafety.reason,
          reviewProposal,
        );
        const safetyOperationKey = `${project.id}:iteration:${iterationNumber}:reactive-safety:round:${continuationSafety.state.executionRounds}:no-progress:${continuationSafety.state.noProgressRounds}:${continuationSafety.reason}`;
        const safetyQuestion = await projectActivities().recordDynamicAgentQuestion(
          project,
          iteration,
          'manager',
          safetyRequest,
          safetyOperationKey,
        );
        await waitForAgentQuestions([safetyQuestion.id], {
          role: 'manager',
          orderId: safetyOperationKey,
        });
        await flushHumanInputs();
        state = 'reviewing';
      } else if (reviewProposalRequiresWakeup(
        reviewProposal.recommendation,
        true,
      )) {
        await condition(() => pendingHumanInputs.length > 0 || resumeVersion > cutoffResumeVersion);
        await flushHumanInputs();
      }
      await continueProjectWorkflow();
      continue;
    }
    state = 'awaiting_approval';
    await projectActivities().setProjectStatus(project.id, 'awaiting_approval');
    while (!pendingReview && !reviewCandidateInvalidated) {
      await condition(() => pendingReview !== undefined
        || pendingHumanInputs.length > 0
        || reviewCandidateInvalidated);
      await flushHumanInputs();
    }
    if (reviewCandidateInvalidated) {
      await reopenReviewAfterHumanGuidance(iterationNumber);
      continue;
    }
    const decision = pendingReview!;
    const reviewIdempotencyKey = pendingReviewIdempotencyKey!;
    const acceptedReviewCheckpoint = activeReviewCheckpoint;
    await flushHumanInputs();
    if (reviewCandidateInvalidated) {
      await reopenReviewAfterHumanGuidance(iterationNumber);
      continue;
    }
    const expectedPreviewRevision = acceptedReviewCheckpoint?.previewRevision;
    const expectedPreviewImageDigest = acceptedReviewCheckpoint?.previewImageDigest;
    const expectedPreviewExpiresAt = acceptedReviewCheckpoint?.previewExpiresAt;
    if (!expectedPreviewRevision || !expectedPreviewImageDigest || !expectedPreviewExpiresAt) {
      throw new Error('Revision-bound review cannot proceed without active preview revision and image-digest evidence.');
    }
    pendingReview = undefined;
    pendingReviewIdempotencyKey = undefined;
    activeReviewCheckpoint = undefined;
    activeReviewProposal = undefined;
    processedReviewIdempotencyKeys.add(reviewIdempotencyKey);
    let lifecycle = await projectActivities().persistIterationReview(
        project.id,
        iterationNumber,
        decision,
        reviewIdempotencyKey,
        expectedPreviewRevision,
        expectedPreviewImageDigest,
      );
    const approved = decision.decision === 'approved' || decision.decision === 'approve';
    while (approved && !lifecycle.merged) {
      const retryScope: AgentExecutionScope = {
        role: 'gate',
        orderId: `${project.id}:i${iterationNumber}:review:${reviewIdempotencyKey}:merge`,
      };
      const retryToken = captureRetry(retryScope);
      state = 'blocked';
      await projectActivities().setProjectStatus(project.id, 'blocked');
      await recordAndDeliverAgentFailure(iterationNumber, 'gate', 'The iteration is approved, but Forgejo did not confirm the pull request merge.');
      await waitForRetry(retryScope, retryToken);
      await flushHumanInputs();
      lifecycle = await projectActivities().finalizeApprovedIterationDelivery(
          project.id,
          iterationNumber,
          reviewIdempotencyKey,
          expectedPreviewRevision,
          expectedPreviewImageDigest,
        );
    }
    const explicitOverallDirection = decision.overallDirection?.trim() ?? '';
    const overallDirection = explicitOverallDirection;
    const artifactFeedbackRoles = new Map<string, AgentRole>();
    if (!approved && (decision.artifactFeedback ?? []).some((feedback) => Boolean(feedback.feedback))) {
      const currentDetail = await projectActivities().getProjectDetail(project.id);
      for (const artifact of currentDetail?.artifacts ?? []) {
        artifactFeedbackRoles.set(artifact.id, artifact.producedBy);
      }
    }
    if (overallDirection) {
      humanGuidance.push({
        key: `iteration:${iterationNumber}:overall`,
        kind: 'overall_direction',
        summary: overallDirection,
      });
    }
    for (const feedback of decision.agentFeedback ?? []) {
      if (!feedback.feedback) continue;
      humanGuidance.push({
        key: `iteration:${iterationNumber}:agent:${feedback.role}`,
        kind: 'agent_feedback',
        role: feedback.role,
        summary: feedback.feedback,
      });
    }
    for (const feedback of decision.artifactFeedback ?? []) {
      if (!feedback.feedback) continue;
      humanGuidance.push({
        key: `iteration:${iterationNumber}:artifact:${feedback.artifactId}`,
        kind: 'artifact_feedback',
        ...(artifactFeedbackRoles.get(feedback.artifactId) ? { role: artifactFeedbackRoles.get(feedback.artifactId) } : {}),
        summary: `Artifact ${feedback.artifactId}: ${feedback.feedback}`,
      });
    }
    if (!approved) {
      const directedRoles = (decision.agentFeedback ?? [])
        .filter((feedback) => Boolean(feedback.feedback))
        .map((feedback) => feedback.role);
      const artifactOwnerRoles = targetedArtifactFeedbackOwnerRoles(
        decision.artifactFeedback ?? [],
        artifactFeedbackRoles,
      );
      nextRoundRoles = targetedReviewReactivationRoles(overallDirection, directedRoles, artifactOwnerRoles);
    }
    if (reviewAdvancesIteration(decision.decision, lifecycle.merged)) iterationNumber += 1;
    context = `${context}\n\nHuman review: ${decision.decision}. ${overallDirection}`.slice(-24_000);
    await continueProjectWorkflow();
  }
}

export async function listProjectsWorkflow(): Promise<ProjectSummary[]> {
  return projectActivities().listProjects();
}

export async function getProjectDetailWorkflow(projectId: string): Promise<ProjectDetail | undefined> {
  return projectActivities().getProjectDetail(projectId);
}
