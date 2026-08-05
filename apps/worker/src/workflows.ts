import { PROJECT_ACTIVITY_TASK_QUEUE, VALIDATION_TASK_QUEUE, agentModelTaskQueue, agentTaskQueue, defaultDynamicExecutionLimits, deliveryAgentGraph, previewAttestationSchema, type AgentArtifactDraft, type AgentArtifactReference, type AgentCommentInput, type AgentExecutionInput, type AgentInteractionKind, type AgentMessage, type AgentOrder, type AgentOrderType, type AgentQuestion, type AgentQuestionAnswerInput, type AgentResult, type AgentRole, type AgentWorkflowInput, type AgentWorkflowResult, type ArtifactFeedbackInput, type DeliveryAgentDefinition, type DynamicExecutionTrace, type DynamicHumanDecisionRequest, type IterationReview, type IterationReviewProposal, type IterationReviewSubmission, type PreviewDeploymentResult, type Project, type ProjectArtifact, type ProjectBrief, type ProjectDetail, type ProjectIteration, type ProjectSummary, type ReviewCheckpoint } from '@orchestra/contracts';
import { ParentClosePolicy, allHandlersFinished, condition, continueAsNew, defineQuery, defineSignal, defineUpdate, executeChild, getExternalWorkflowHandle, makeContinueAsNewFunc, patched, proxyActivities, setHandler, startChild, workflowInfo } from '@temporalio/workflow';
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

const legacyPersistence = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

function projectActivities() {
  return patched('split-project-activity-queue-v1') ? splitPersistence : legacyPersistence;
}

interface ModelActivities {
  runAgent(input: AgentExecutionInput): Promise<AgentArtifactDraft>;
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
}

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

const legacyModel = proxyActivities<ModelActivities>({
  taskQueue: 'orchestra-models',
  startToCloseTimeout: '30 minutes',
  scheduleToCloseTimeout: '2 hours',
  retry: { maximumAttempts: 2, initialInterval: '10 seconds' },
});

const validation = proxyActivities<ValidationActivities>({
  taskQueue: VALIDATION_TASK_QUEUE,
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 2, initialInterval: '15 seconds' },
});

type DeliveryRole = Exclude<AgentRole, 'deployment' | 'validation'>;

const legacyAgentGraph: Array<{ role: DeliveryRole; artifactType: string; artifactName: string; status: 'defining' | 'planning' | 'building' | 'reviewing' }> = [
  { role: 'manager', artifactType: 'project-charter', artifactName: 'Project charter', status: 'defining' },
  { role: 'requirements', artifactType: 'requirements-baseline', artifactName: 'Requirements baseline', status: 'defining' },
  { role: 'product', artifactType: 'product-scope', artifactName: 'Product scope', status: 'defining' },
  { role: 'ux', artifactType: 'user-journeys', artifactName: 'User journeys', status: 'defining' },
  { role: 'architecture', artifactType: 'solution-baseline', artifactName: 'Solution baseline', status: 'planning' },
  { role: 'data', artifactType: 'data-model', artifactName: 'Data model', status: 'planning' },
  { role: 'security', artifactType: 'threat-model', artifactName: 'Threat model', status: 'planning' },
  { role: 'planner', artifactType: 'iteration-plan', artifactName: 'Iteration plan', status: 'planning' },
  { role: 'builder', artifactType: 'build-submission', artifactName: 'Build submission', status: 'building' },
  { role: 'test', artifactType: 'test-evidence', artifactName: 'Test evidence', status: 'reviewing' },
  { role: 'reviewer', artifactType: 'review-decision', artifactName: 'Review decision', status: 'reviewing' },
  { role: 'gate', artifactType: 'gate-decision', artifactName: 'Gate decision', status: 'reviewing' },
];

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

type ModelInteractionWorkflow = (input: AgentExecutionInput) => Promise<AgentArtifactDraft>;
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
  const graphHandoffs = patched('agent-artifact-handoffs-v1');
  const legacyRevisionBoundAssuranceLedger = patched('revision-bound-assurance-ledger-v1');
  const revisionBoundAssuranceLedger = patched('parent-owned-assurance-mode-v1')
    ? input.revisionBoundAssurance ?? Boolean(input.preview)
    : legacyRevisionBoundAssuranceLedger;
  const artifactAfterTestEvidence = patched('agent-artifact-after-test-evidence-v1');
  const canonicalAgentExecutionLedger = patched('canonical-agent-execution-ledger-v1');
  const resumeStagedArtifact = patched('resume-staged-agent-artifact-v1');
  const boundArtifactRecoveryEnvelope = patched('bound-artifact-recovery-envelope-v1');
  const enforceProviderBudgets = patched('provider-budget-enforcement-v1');
  const assuranceRole = input.role === 'test' || input.role === 'reviewer' || input.role === 'gate';
  if (revisionBoundAssuranceLedger && assuranceRole && !input.preview) {
    throw new Error(`${input.role} evidence requires an immutable preview revision.`);
  }
  const order = assignedOrder ?? runtimeOrderForExecution(input, `${modelRequestId}/order`);
  const ledgerOrder = input.executionOperationId && order.orderId !== input.executionOperationId
    ? { ...order, orderId: input.executionOperationId }
    : order;
  let artifactOperationKey = agentArtifactPersistenceOperationKey(input, modelRequestId);
  const mayRecoverArtifact = resumeStagedArtifact
    && Boolean(input.artifactOperationId || input.executionOperationId);
  const recoveredDraft = !mayRecoverArtifact
    ? undefined
    : boundArtifactRecoveryEnvelope
      ? await projectActivities().loadAgentArtifactOperationDraft(input.project.id, artifactOperationKey, {
        iterationId: input.iteration.id,
        type: input.artifactType,
        producedBy: input.role,
        storage: revisionBoundAssuranceLedger && assuranceRole ? 'ledger' : 'repository',
        sourceRevision: revisionBoundAssuranceLedger && assuranceRole ? input.preview!.revision : null,
      })
      : await projectActivities().loadAgentArtifactOperationDraft(input.project.id, artifactOperationKey);
  if (!recoveredDraft) {
    if (graphHandoffs) {
      await projectActivities().recordAgentStarted(input.project, input.iteration, input.role, input.inputArtifacts ?? [], input.supervisedBy ?? []);
    } else {
      await projectActivities().recordAgentStarted(input.project, input.iteration, input.role);
    }
    if (canonicalAgentExecutionLedger) {
      await projectActivities().persistAgentOrderLedger(
        input.project.id,
        input.iteration.id,
        input.role,
        ledgerOrder,
        `iteration:${input.iteration.number}:${input.role}`,
        input.preview?.revision,
      );
    }
  }
  let draft: AgentArtifactDraft;
  let executionTrace: DynamicExecutionTrace | undefined;
  if (recoveredDraft) {
    draft = recoveredDraft;
    executionTrace = recoveredDraft.executionTrace;
  } else if (patched('dynamic-agent-execution-loop-v1')) {
    // Resuming from an interpreter checkpoint changes child-workflow command
    // identities and control flow, so old histories must stay on the restart
    // behavior they originally recorded.
    const resumableHumanDecision = patched('dynamic-agent-human-decision-resume-v1');
    // Histories that already planned at context version 0 must replay their
    // recorded commands unchanged. A later explicit resume advances the
    // version and can safely pick up this liveness fix on the next order.
    const discardTerminalControlActions = patched('terminal-control-plan-actions-v1')
      || (input.executionContextVersion !== undefined && input.executionContextVersion > 0);
    const serializeArtifactActions = patched('single-artifact-action-batches-v1')
      || (input.executionContextVersion !== undefined
        && input.executionContextVersion >= 3
        && patched('single-artifact-action-batches-resume-v1'));
    const bindPlanningContextVersion = patched('bind-dynamic-plan-context-v1')
      || (input.executionContextVersion !== undefined
        && input.executionContextVersion >= 5
        && patched('bind-dynamic-plan-context-resume-v1'));
    const discardModelAuthoredArguments = patched('workflow-owned-model-action-arguments-v1')
      || (input.executionContextVersion !== undefined
        && input.executionContextVersion > 10
        && patched('workflow-owned-model-action-arguments-resume-v1'));
    const normalizeDecisionOptions = patched('normalize-dynamic-decision-options-v1')
      || (input.executionContextVersion !== undefined
        && input.executionContextVersion > 12
        && patched('normalize-dynamic-decision-options-resume-v1'));
    const normalizeDecisionEnvelope = patched('normalize-dynamic-decision-envelope-v1')
      || (input.executionContextVersion !== undefined
        && input.executionContextVersion > 16
        && patched('normalize-dynamic-decision-envelope-resume-v1'));
    const normalizeArtifactStateTransitionsV1 = patched('workflow-owned-artifact-state-transitions-v1')
      || (input.executionContextVersion !== undefined
        && input.executionContextVersion > 18
        && patched('workflow-owned-artifact-state-transitions-resume-v1'));
    const normalizeArtifactStateTransitionsV2 = patched('workflow-owned-artifact-state-transitions-v2')
      || (input.executionContextVersion !== undefined
        && input.executionContextVersion > 0
        && patched('workflow-owned-artifact-state-transitions-resume-v2'));
    const normalizeArtifactStateTransitions = normalizeArtifactStateTransitionsV1
      || normalizeArtifactStateTransitionsV2;
    const checkpoint = resumableHumanDecision ? executionCheckpoint : undefined;
    // Preserve commands already recorded by older histories, while enabling
    // the refresh for every newly executed human-decision resume. The version
    // fallback lets the original long-lived rollout advance on a later order.
    const refreshCandidateAfterHumanDecision = checkpoint !== undefined
      && (patched('refresh-candidate-after-human-decision-v1')
        || (input.executionContextVersion !== undefined
          && input.executionContextVersion > 28
          && patched('refresh-candidate-after-human-decision-resume-v1')));
    const honorHumanReviewWaiver = checkpoint !== undefined
      && patched('human-review-waiver-at-revision-limit-v1');
    const deferQuestionsAfterHumanReviewWaiver = checkpoint !== undefined
      && patched('defer-questions-after-human-review-waiver-v1');
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
      ...(enforceProviderBudgets ? { enforceProviderBudgets: true } : {}),
      ...(discardTerminalControlActions ? { discardTerminalControlActions: true } : {}),
      ...(serializeArtifactActions ? { serializeArtifactActions: true } : {}),
      ...(bindPlanningContextVersion ? { bindPlanningContextVersion: true } : {}),
      ...(discardModelAuthoredArguments ? { discardModelAuthoredArguments: true } : {}),
      ...(normalizeDecisionOptions ? { normalizeDecisionOptions: true } : {}),
      ...(normalizeDecisionEnvelope ? { normalizeDecisionEnvelope: true } : {}),
      ...(normalizeArtifactStateTransitions ? { normalizeArtifactStateTransitions: true } : {}),
      ...(refreshCandidateAfterHumanDecision ? { refreshCandidateAfterHumanDecision: true } : {}),
      ...(honorHumanReviewWaiver ? { honorHumanReviewWaiver: true } : {}),
      ...(deferQuestionsAfterHumanReviewWaiver ? { deferQuestionsAfterHumanReviewWaiver: true } : {}),
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
      if (canonicalAgentExecutionLedger) {
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
      }
      return {
        status: 'waiting_for_human',
        question,
        executionTrace: dynamic.trace,
        ...(resumableHumanDecision ? { executionCheckpoint: dynamic.checkpoint } : {}),
      };
    }
    if (dynamic.status !== 'completed') {
      if (canonicalAgentExecutionLedger) {
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
      }
      return {
        status: dynamic.status,
        reason: dynamic.reason,
        executionTrace: dynamic.trace,
      };
    }
    draft = { ...dynamic.draft, executionTrace: dynamic.trace };
  } else {
    draft = patched('model-interaction-child-workflow-v1')
      ? await executeChild<ModelInteractionWorkflow>('modelInteractionWorkflow', {
        workflowId: modelRequestId,
        taskQueue: agentModelTaskQueue(input.role),
        args: [input],
      })
      : await legacyModel.runAgent(input);
  }
  draft.name = input.artifactName;
  const recordTestEvidence = async (idempotent: boolean): Promise<void> => {
    if (input.role === 'test' && input.preview) {
      const recording = await validation.captureUserFlow({ project: input.project, iteration: input.iteration, preview: input.preview });
      if (recording.revision !== input.preview.revision) {
        throw new Error('User-flow recording did not attest to the requested preview revision.');
      }
      if (idempotent) {
        await projectActivities().recordUserFlowMedia(
          input.project,
          input.iteration,
          recording,
          input.preview,
          agentUserFlowMediaOperationKey(input, modelRequestId),
        );
      } else {
        await projectActivities().recordUserFlowMedia(input.project, input.iteration, recording, input.preview);
      }
    } else if (input.role === 'test' && input.project.previewUrl) {
      // Replay compatibility for Test workflows started before revision-bound previews.
      const recording = await validation.captureUserFlow({ project: input.project, iteration: input.iteration });
      if (idempotent) {
        await projectActivities().recordUserFlowMedia(
          input.project,
          input.iteration,
          recording,
          undefined,
          agentUserFlowMediaOperationKey(input, modelRequestId),
        );
      } else {
        await projectActivities().recordUserFlowMedia(input.project, input.iteration, recording);
      }
    }
  };
  if (artifactAfterTestEvidence) await recordTestEvidence(true);
  const recorded = revisionBoundAssuranceLedger && assuranceRole
    ? await projectActivities().recordAgentArtifact(
      input.project,
      input.iteration,
      draft,
      artifactOperationKey,
      {
        storage: 'ledger',
        sourceRevision: input.preview!.revision,
        ...(boundArtifactRecoveryEnvelope ? { bindRecoveryEnvelope: true } : {}),
      },
    )
    : boundArtifactRecoveryEnvelope
      ? await projectActivities().recordAgentArtifact(
        input.project,
        input.iteration,
        draft,
        artifactOperationKey,
        { storage: 'repository', bindRecoveryEnvelope: true },
      )
      : await projectActivities().recordAgentArtifact(
        input.project,
        input.iteration,
        draft,
        artifactOperationKey,
      );
  if (recorded.draft) {
    draft = recorded.draft;
    executionTrace = recorded.draft.executionTrace;
  }
  if (!artifactAfterTestEvidence) await recordTestEvidence(false);
  if (canonicalAgentExecutionLedger && !input.deferCompletionLedger) {
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
  if (!graphHandoffs) return draft;
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

/** New-workflow entry point used only after the resume patch is active. */
export const resumableAgentWorkflow = (invocation: ResumableAgentWorkflowInvocation) => executeAgent(
  invocation.input,
  invocation.modelRequestId,
  invocation.order,
  invocation.executionCheckpoint,
);

const agentWorkflows = {
  manager: managerAgentWorkflow,
  requirements: requirementsAgentWorkflow,
  product: productAgentWorkflow,
  ux: uxAgentWorkflow,
  architecture: architectureAgentWorkflow,
  data: dataAgentWorkflow,
  security: securityAgentWorkflow,
  planner: plannerAgentWorkflow,
  builder: builderAgentWorkflow,
  test: testAgentWorkflow,
  reviewer: reviewerAgentWorkflow,
  gate: gateAgentWorkflow,
  deployment: deploymentAgentWorkflow,
  validation: validationAgentWorkflow,
} as const;

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
  // Adding projection Activities and extra in-workflow state transitions to a
  // long-lived actor changes its command history. Keep old histories on their
  // recorded path while new runs adopt the living-organism projection.
  const livingOrganismProjection = patched('living-organism-runtime-projection-v1');
  const livingOrganismMessageLedger = patched('living-organism-message-ledger-v1');
  const actorMailboxDelivery = patched('living-organism-actor-mailbox-delivery-v1');
  const terminalOutcomeWins = patched('agent-terminal-outcome-wins-v1');
  const historyAwareActorContinuation = patched('agent-actor-history-aware-continuation-v1');

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
      || (historyAwareActorContinuation
        && workflowInfo().continueAsNewSuggested
        && shouldContinueAsNew(state, 1));
    if (state.mailbox.length > 0 || !continuationDue) return;
    const recent = state.receivedMessages.slice(-100);
    const nextBootstrap: AgentBootstrap = {
      address: state.address,
      role: state.role,
      mode: state.mode,
      ...(livingOrganismProjection ? {
        presentationState: state.presentationState,
        activity: state.activity,
        stateChangedAt: state.stateChangedAt,
      } : {}),
      graphVersion: state.graphVersion,
      projectStateVersion: state.projectStateVersion,
      stateVersion: state.stateVersion,
      continuationSequence: state.continuationSequence + 1,
      recentMessageIds: recent.map((message) => message.messageId),
      recentIdempotencyKeys: recent.map((message) => message.idempotencyKey),
      continueAsNewEventThreshold: state.continueAsNewEventThreshold,
    };
    if (patched('agent-actor-task-queue-migration-v1')) {
      await makeContinueAsNewFunc<typeof persistentAgentRoleWorkflow>({
        taskQueue: agentTaskQueue(state.role),
      })(nextBootstrap);
    } else {
      await continueAsNew<typeof persistentAgentRoleWorkflow>(nextBootstrap);
    }
  }

  while (true) {
    await condition(() => state.mailbox.length > 0);
    const dequeued = dequeueNextMessage(state);
    state = dequeued.state;
    const message = dequeued.message;
    if (!message) continue;

    if (actorMailboxDelivery && !isAgentExecutionCommandMessage(message)) {
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
    if (livingOrganismMessageLedger) {
      await projectActivities().transitionAgentMessage(
        message.projectId,
        message.idempotencyKey,
        'acknowledged',
        state.role,
      );
    }
    if (livingOrganismProjection) {
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
        if (livingOrganismProjection) {
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
        if (livingOrganismMessageLedger) {
          await projectActivities().transitionAgentMessage(
            message.projectId,
            message.idempotencyKey,
            'completed',
            state.role,
          );
        }
        await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, terminalResponse);
        if (terminalOutcomeWins) await continueActorIfNeeded();
        continue;
      }
      if (isAgentWorkflowStoppedResult(execution)) {
        terminalResponse = {
          orderId: payload.orderId,
          role: state.role,
          stopped: execution,
        };
        const terminalSummary = `${execution.status.toUpperCase()}: ${execution.reason}`;
        if (livingOrganismProjection) {
          const activeOrder = payload.order && state.orders.find((record) =>
            record.order.orderId === payload.order!.orderId
            && ['ACCEPTED', 'IN_PROGRESS', 'BLOCKED'].includes(record.status));
          if (payload.order && activeOrder) {
            state = recordResult(state, {
              orderId: payload.order.orderId,
              role: state.role,
              status: terminalOutcomeWins ? 'FAILED' : 'BLOCKED',
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
        if (livingOrganismMessageLedger) {
          await projectActivities().transitionAgentMessage(
            message.projectId,
            message.idempotencyKey,
            'failed',
            state.role,
          );
        }
        await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, terminalResponse);
        if (terminalOutcomeWins) await continueActorIfNeeded();
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
      if (livingOrganismProjection) {
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
      if (livingOrganismMessageLedger) {
        await projectActivities().transitionAgentMessage(
          message.projectId,
          message.idempotencyKey,
          'completed',
          state.role,
        );
      }
      await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, terminalResponse);
    } catch (error) {
      if (terminalOutcomeWins && terminalResponse) {
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
        if (livingOrganismProjection) {
          const activeOrder = payload.order && state.orders.find((record) =>
            record.order.orderId === payload.order!.orderId
            && ['ACCEPTED', 'IN_PROGRESS', 'BLOCKED'].includes(record.status));
          if (payload.order && activeOrder) {
            state = recordResult(state, {
          orderId: payload.order.orderId,
          role: state.role,
          status: terminalOutcomeWins ? 'FAILED' : 'BLOCKED',
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
        if (livingOrganismProjection) {
          await persistActorRuntimeState(state, payload.input, message.correlationId);
        }
      } catch (cleanupError) {
        failure = `${failure} Actor cleanup also failed: ${describeModelFailure(cleanupError)}`.slice(0, 10_000);
      }
      if (livingOrganismMessageLedger) {
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
): string {
  const artifactHistory = artifactContext(baseContext, artifacts).slice(-18_000);
  const liveControlContext = repositoryAndHumanContext(project, iteration, role, guidance).slice(-6_000);
  return `${artifactHistory}\n\n${liveControlContext}`.slice(-24_000);
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
  const continueProjectAtReviewBoundary = patched('project-review-boundary-continue-as-new-v1');
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
  const scopedHumanDecisionResume = patched('dynamic-agent-human-decision-resume-v1');
  const reviewProposalEnforcement = patched('living-organism-review-proposal-enforcement-v1');
  const humanGuidanceInvalidatesReview = patched('human-guidance-invalidates-review-v1');
  const pagedHumanGuidance = patched('paged-human-guidance-v1');
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
    if (!humanGuidanceInvalidatesReview) return;
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
    if (scopedHumanDecisionResume) humanDecisionCoordinator.resume(scope);
  });
  setHandler(enableDurableHumanGuidance, () => {
    durableHumanGuidanceEnabled = true;
    decisionReconciliationRequested = true;
    resumeVersion += 1;
    if (scopedHumanDecisionResume) humanDecisionCoordinator.requestQuestionRecheck();
  });
  setHandler(answerAgentQuestion, (value) => {
    pendingHumanInputs.push({ kind: 'question_answer', value });
    decisionReconciliationRequested = true;
    resumeVersion += 1;
    if (scopedHumanDecisionResume) humanDecisionCoordinator.noteQuestionInput(value.questionId);
  });
  setHandler(answerAgentQuestionAndWait, async (value) => {
    pendingHumanInputs.push({ kind: 'question_answer', value });
    decisionReconciliationRequested = true;
    resumeVersion += 1;
    if (scopedHumanDecisionResume) humanDecisionCoordinator.noteQuestionInput(value.questionId);
    // Unlike the legacy fire-and-forget Signal, an Update does not acknowledge
    // the HTTP request until the durable database answer exists.
    await flushHumanInputs();
  });
  setHandler(commentOnAgent, (value) => {
    if (value.projectId !== project.id) return;
    pendingHumanInputs.push({ kind: 'agent_comment', value });
    invalidateActiveReviewCandidate(value.agentRole);
    if (reviewProposalEnforcement) resumeVersion += 1;
  });
  setHandler(commentOnArtifact, (value) => {
    pendingHumanInputs.push({ kind: 'artifact_feedback', value });
    invalidateActiveReviewCandidate();
    if (reviewProposalEnforcement) resumeVersion += 1;
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
    if (!pagedHumanGuidance) {
      const legacy = await projectActivities().getProjectHumanGuidance(project.id);
      return Array.isArray(legacy) ? legacy : legacy.entries;
    }
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
    if ((canonicalHumanDecisions || patched('canonical-human-decisions-live-reconcile-v2'))
      && decisionReconciliationRequested) {
      await projectActivities().reconcileAgentQuestionDecisions(project.id);
      decisionReconciliationRequested = false;
    }
    while (pendingHumanInputs.length > 0) {
      const item = pendingHumanInputs.shift()!;
      if (item.kind === 'question_answer') {
        if (scopedHumanDecisionResume) humanDecisionCoordinator.beginQuestionPersistence(item.value.questionId);
        const answered = await projectActivities().persistAgentQuestionAnswer(project.id, item.value.questionId, item.value.answer);
        if (scopedHumanDecisionResume) humanDecisionCoordinator.markQuestionAnswered(item.value.questionId);
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
          ...(patched('global-human-decision-context-v1') ? {} : { role: answered.agentRole }),
          summary: `Answer to “${answered.question}”: ${answer}`,
        });
      } else if (item.kind === 'agent_comment') {
        const message = humanGuidanceActorMailbox
          ? await projectActivities().persistAgentComment(item.value, 'actor_mailbox')
          : await projectActivities().persistAgentComment(item.value);
        await deliverActorMailboxMessage(message);
        humanGuidance.push({
          key: `agent-comment:${item.value.agentRole}:${humanGuidance.length}`,
          kind: 'agent_comment',
          role: item.value.agentRole,
          summary: item.value.body,
        });
      } else {
        const persistedFeedback = humanGuidanceActorMailbox
          ? await projectActivities().persistArtifactFeedback(project.id, item.value, 'actor_mailbox')
          : await projectActivities().persistArtifactFeedback(project.id, item.value);
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
    if (durableHumanGuidanceEnabled || patched('durable-human-guidance-v1')) {
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
    if (!scopedHumanDecisionResume) {
      while (!(await projectActivities().areAgentQuestionsAnswered(project.id, questionIds))) {
        await condition(() => pendingHumanInputs.length > 0);
        await flushHumanInputs();
      }
      return;
    }
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

  function captureRetry(scope: AgentExecutionScope): number | AgentRetryToken {
    return scopedHumanDecisionResume
      ? humanDecisionCoordinator.captureRetry(scope)
      : resumeVersion;
  }

  async function waitForRetry(
    scope: AgentExecutionScope,
    token: number | AgentRetryToken,
  ): Promise<void> {
    if (typeof token === 'number') {
      const capturedResumeVersion = token;
      await condition(() => resumeVersion > capturedResumeVersion);
      return;
    }
    await condition(() => humanDecisionCoordinator.shouldRetry(scope, token));
  }

  const patchedPersistentActors = patched('persistent-agent-actors-v1');
  const persistentActors = continuation?.persistentActors ?? patchedPersistentActors;
  const patchedActorMailboxDelivery = persistentActors && patched('living-organism-actor-mailbox-delivery-v1');
  const actorMailboxDelivery = continuation?.actorMailboxDelivery ?? patchedActorMailboxDelivery;
  const patchedHumanGuidanceActorMailbox = actorMailboxDelivery && patched('human-guidance-actor-mailbox-v1');
  const humanGuidanceActorMailbox = continuation?.humanGuidanceActorMailbox ?? patchedHumanGuidanceActorMailbox;
  const patchedSplitAgentTaskQueues = patched('split-agent-task-queues-v1');
  const splitAgentTaskQueues = continuation?.splitAgentTaskQueues ?? patchedSplitAgentTaskQueues;
  const revisionBoundPreviews = patched('revision-bound-mandatory-preview-v1');
  const revisionBoundAssuranceLedger = patched('revision-bound-assurance-ledger-v1');
  const parentOwnedAssuranceMode = patched('parent-owned-assurance-mode-v1');
  const reactiveOrganismActivation = patched('reactive-organism-activation-v1');
  const reactiveCurrentIterationContext = reactiveOrganismActivation
    && patched('reactive-current-iteration-context-v1');
  const autonomousReactiveContinuation = reactiveOrganismActivation
    && patched('autonomous-reactive-continuation-v1');
  const outerReactiveSafetyGuard = autonomousReactiveContinuation
    && patched('outer-reactive-safety-guard-v1');
  const imageDigestAttestations = patched('preview-image-digest-attestation-v1');
  const canonicalHumanDecisions = patched('canonical-human-decisions-v1');
  const stableArtifactOperationKeys = patched('stable-agent-artifact-operation-v1');
  const correctiveArtifactOperationKeys = patched('corrective-artifact-operation-v1');
  const idempotentFinalReviewMedia = patched('final-review-media-idempotency-v1');
  const builderPreflightBeforeHandoff = patched('builder-preflight-before-handoff-v1');
  const completionAfterHandoff = patched('completion-after-handoff-v1');
  const completionAfterParentVerification = patched('completion-after-parent-verification-v1');
  const parentOwnsCompletionLedger = completionAfterHandoff || completionAfterParentVerification;
  const canonicalExecutionLedger = patched('canonical-agent-execution-ledger-v1');
  const structuredGateProposalRationale = patched('structured-gate-proposal-rationale-v1');
  const targetedReviewFeedbackActivation = patched('targeted-review-feedback-activation-v1');
  if (persistentActors && !continuation) {
    await Promise.all(deliveryAgentGraph.map((definition) => startChild(persistentAgentRoleWorkflow, {
      workflowId: agentWorkflowId(project.id, definition.role),
      ...(splitAgentTaskQueues ? { taskQueue: agentTaskQueue(definition.role) } : {}),
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
    if (!actorMailboxDelivery) return;
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
    const message = actorMailboxDelivery
      ? await projectActivities().recordAgentHandoff(
        project,
        iteration,
        role,
        artifacts,
        handsOffTo,
        'actor_mailbox',
      )
      // Preserve the original Activity arguments for histories recorded before
      // the mailbox patch marker existed.
      : await projectActivities().recordAgentHandoff(project, iteration, role, artifacts, handsOffTo);
    await deliverActorMailboxMessage(message);
  }

  async function completeAgentLedgerAfterHandoff(
    input: AgentWorkflowInput,
    result: AgentWorkflowExecutionResult,
    logicalOrderId: string,
  ): Promise<void> {
    if (!parentOwnsCompletionLedger || !canonicalExecutionLedger) return;
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
    if (!completionAfterParentVerification || !canonicalExecutionLedger) return;
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
    const message = actorMailboxDelivery
      ? await projectActivities().recordAgentFailure(
        project.id,
        iterationNumber,
        role,
        failure,
        'actor_mailbox',
      )
      // Preserve the original Activity arguments on the replay path.
      : await projectActivities().recordAgentFailure(project.id, iterationNumber, role, failure);
    await deliverActorMailboxMessage(message);
  }

  async function executeThroughAgentActor(
    input: AgentWorkflowInput,
    orderId: string,
    executionCheckpoint?: DynamicArtifactExecutionCheckpoint,
  ): Promise<AgentWorkflowExecutionResult | AgentWorkflowWaitingResult | AgentWorkflowStoppedResult> {
    const recipientWorkflowId = agentWorkflowId(project.id, input.role);
    const order = runtimeOrderForExecution(input, orderId);
    const structuredAgentOrder = patched('living-organism-structured-agent-orders-v1');
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
        ...(structuredAgentOrder ? { order } : {}),
        input,
        replyWorkflowId: workflowInfo().workflowId,
        ...(scopedHumanDecisionResume && executionCheckpoint ? { executionCheckpoint } : {}),
      },
      acknowledgementRequired: true,
      createdAt: new Date().toISOString(),
    };
    if (patched('living-organism-message-ledger-v1')) {
      await projectActivities().persistAgentMessage(message);
    }
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
    if (!humanGuidanceInvalidatesReview) return false;
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
    if (reactiveOrganismActivation) {
      nextRoundRoles = reactiveIterationRoles(pendingReviewReworkRoles);
    }
    reviewCandidateInvalidated = false;
    pendingReviewReworkRoles = [];
    return true;
  }

  while (true) {
    executionRound += 1;
    if (outerReactiveSafetyGuard) {
      reactiveIterationSafety = beginReactiveIterationRound(reactiveIterationSafety, iterationNumber);
    }
    const roundStartResumeVersion = resumeVersion;
    let iteration = await projectActivities().getIteration(project.id, iterationNumber);
    iteration = await projectActivities().prepareIterationRepository(project, iteration);
    await flushHumanInputs();
    let previewAttempted = false;
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
      if (!builderPreflightBeforeHandoff) return;
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
      if (revisionBoundPreviews) {
        if (!testPreview) {
          testPreview = await deployMandatoryPreview();
          // A failed attempt marks the iteration blocked; a successful retry
          // restores the pre-review lifecycle before Test is allowed to start.
          await projectActivities().setIterationStatus(project.id, iterationNumber, 'active');
        }
        return testPreview;
      }
      if (previewAttempted) return;
      previewAttempted = true;
      try {
        const existingPreview = await projectActivities().getIterationPreview(project.id, iteration.id);
        const preview = await validation.deployIterationPreview({ project, iteration, existingPreview });
        project = await projectActivities().recordIterationPreview(project, iteration, preview);
        // A legacy parent history may reach a not-yet-started Test child after
        // the activity worker has already adopted the new contract. Forward
        // that explicit target without changing recorded legacy activity data.
        if ('revision' in preview) {
          testPreview = revisionBoundPreview(preview);
          return testPreview;
        }
      } catch (error) {
        await projectActivities().recordPreviewUnavailable(project.id, iteration.number, describeModelFailure(error));
      }
    };

    if (!patched('dependency-aware-agent-graph-v1')) {
      for (const step of legacyAgentGraph) {
        const preview = step.role === 'test'
          ? await ensureIterationPreview()
          : revisionBoundAssuranceLedger && (step.role === 'reviewer' || step.role === 'gate')
            ? testPreview
            : undefined;
        state = step.status;
        await projectActivities().setProjectStatus(project.id, step.status);
        let draft: AgentArtifactDraft | undefined;
        let agentAttempt = 0;
        let executionCheckpoint: DynamicArtifactExecutionCheckpoint | undefined;
        let verificationFailure: string | undefined;
        let artifactRevision = 0;
        const executionScope: AgentExecutionScope = {
          role: step.role,
          orderId: stableArtifactOperationKeys
            ? `${project.id}:i${iterationNumber}:legacy:run${executionRound}:${step.role}`
            : `${project.id}:i${iterationNumber}:legacy:${step.role}`,
        };
        while (!draft) {
          try {
            agentAttempt += 1;
            await flushHumanInputs();
            const definition = deliveryAgentGraph.find((candidate) => candidate.role === step.role)!;
            const priorArtifacts = await projectActivities().getPriorAgentArtifacts(
              project.id,
              iterationNumber,
              agentArtifactContextPatterns(definition),
            );
            const input: AgentWorkflowInput = {
              project,
              iteration,
              role: step.role,
              artifactType: step.artifactType,
              artifactName: step.artifactName,
              ...(stableArtifactOperationKeys ? { executionOperationId: executionScope.orderId } : {}),
              ...(correctiveArtifactOperationKeys
                ? { artifactOperationId: `${executionScope.orderId}:artifact-revision:${artifactRevision}` }
                : {}),
              ...(parentOwnedAssuranceMode ? { revisionBoundAssurance: revisionBoundAssuranceLedger } : {}),
              ...(parentOwnsCompletionLedger ? { deferCompletionLedger: true } : {}),
              context: `${agentOrderContext(context, project, iteration, step.role, priorArtifacts, humanGuidance)}${verificationFailure
                ? `\n\n## Deterministic verification failure from the previous attempt\n${verificationFailure}\nCorrect this failure before returning the next complete artifact set.`
                : ''}`,
              inputArtifacts: priorArtifacts,
              requiredDecisionIds: requiredHumanDecisionIds(humanGuidance, step.role),
              executionContextVersion: resumeVersion,
              ...(preview ? { preview } : {}),
            };
            const childWorkflowId = `${workflowInfo().workflowId}-i${iterationNumber}-${step.role}-${agentAttempt}`;
            const execution = scopedHumanDecisionResume && executionCheckpoint
              ? await executeChild<typeof resumableAgentWorkflow>('resumableAgentWorkflow', {
                workflowId: childWorkflowId,
                ...(splitAgentTaskQueues ? { taskQueue: agentTaskQueue(step.role) } : {}),
                args: [{
                  input,
                  modelRequestId: executionCheckpoint.executionId,
                  order: runtimeOrderForExecution(input, executionScope.orderId),
                  executionCheckpoint,
                }],
              })
              : await executeChild(agentWorkflows[step.role], {
                workflowId: childWorkflowId,
                ...(splitAgentTaskQueues ? { taskQueue: agentTaskQueue(step.role) } : {}),
                args: [input],
              });
            if (isAgentWorkflowWaitingResult(execution)) {
              executionCheckpoint = execution.executionCheckpoint;
              await waitForAgentQuestions([execution.question.id], executionScope);
              continue;
            }
            if (isAgentWorkflowStoppedResult(execution)) {
              throw new Error(`${execution.status.toUpperCase()}: ${execution.reason}`);
            }
            const result = execution;
            if ('draft' in result) {
              await waitForAgentQuestions(result.questionIds, executionScope);
              try {
                if (step.role === 'builder') {
                  try {
                    await verifyBuilderRevisionBeforeHandoff();
                  } catch (error) {
                    if (correctiveArtifactOperationKeys) {
                      await projectActivities().rejectAgentArtifacts(
                        project.id,
                        result.artifacts.map((artifact) => artifact.id),
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
                  result.artifacts,
                  downstreamRoles(step.role),
                );
                await completeAgentLedgerAfterHandoff(input, result, executionScope.orderId);
              } catch (error) {
                await blockAgentLedgerAfterParentVerification(
                  input,
                  result,
                  executionScope.orderId,
                  describeModelFailure(error),
                );
                throw error;
              }
              draft = result.draft;
            } else {
              draft = result;
            }
          } catch (error) {
            verificationFailure = describeModelFailure(error);
            const retryToken = captureRetry(executionScope);
            state = 'blocked';
            await projectActivities().setProjectStatus(project.id, 'blocked');
            await recordAndDeliverAgentFailure(iterationNumber, step.role, describeModelFailure(error));
            await waitForRetry(executionScope, retryToken);
            await flushHumanInputs();
          }
        }
        context = `${context}\n\n## ${draft.name}\n${draft.content}`.slice(-24_000);
      }
    } else {
      const completed = new Map<AgentRole, AgentWorkflowExecutionResult>();
      const executionInputs = new Map<AgentRole, AgentArtifactReference[]>();
      let gateLedgerContext: { input: AgentWorkflowInput; logicalOrderId: string } | undefined;
      const selectedRoundRoles = nextRoundRoles;
      const includeCurrentIterationContext = reactiveCurrentIterationContext
        && selectedRoundRoles !== undefined;
      const scheduledRoles = reactiveOrganismActivation
        ? new Set(selectedRoundRoles ?? iterationAgentGraph.map((step) => step.role))
        : new Set(iterationAgentGraph.map((step) => step.role));
      nextRoundRoles = undefined;
      const remaining = new Set<AgentRole>(scheduledRoles);
      const running = new Map<AgentRole, Promise<readonly [AgentRole, AgentWorkflowExecutionResult]>>();

      while (remaining.size > 0 || running.size > 0) {
        await flushHumanInputs();
        const ready = iterationAgentGraph.filter((step) =>
          remaining.has(step.role)
          && step.dependsOn.every((dependency) => !scheduledRoles.has(dependency) || completed.has(dependency)),
        );
        if (ready.length > 0) {
          if (ready.some((step) => step.role === 'test'
            || (revisionBoundAssuranceLedger && (step.role === 'reviewer' || step.role === 'gate')))) {
            await ensureIterationPreview();
          }
          const projectStatus = ready.some((step) => step.projectStatus === 'building') ? 'building'
            : ready.some((step) => step.projectStatus === 'reviewing') ? 'reviewing'
              : ready.some((step) => step.projectStatus === 'planning') ? 'planning' : 'defining';
          state = projectStatus;
          await projectActivities().setProjectStatus(project.id, projectStatus);

          for (const step of ready) {
            remaining.delete(step.role);
            const priorArtifacts = includeCurrentIterationContext
              ? await projectActivities().getPriorAgentArtifacts(
                project.id,
                iterationNumber,
                agentArtifactContextPatterns(step),
                { includeCurrentIteration: true },
              )
              // Preserve the original Activity arguments for histories before
              // the current-iteration reactive-context patch.
              : await projectActivities().getPriorAgentArtifacts(
                project.id,
                iterationNumber,
                agentArtifactContextPatterns(step),
              );
            const inputArtifacts = mergeAgentArtifactContext(collectInputArtifacts(step, completed), priorArtifacts);
            executionInputs.set(step.role, inputArtifacts);
            running.set(step.role, (async () => {
              let result: AgentWorkflowExecutionResult | undefined;
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
                  const input: AgentWorkflowInput = {
                    project,
                    iteration,
                    role: step.role,
                    artifactType: step.artifactType,
                    artifactName: step.artifactName,
                    ...(stableArtifactOperationKeys ? { executionOperationId: executionScope.orderId } : {}),
                    ...(correctiveArtifactOperationKeys
                      ? { artifactOperationId: `${executionScope.orderId}:artifact-revision:${artifactRevision}` }
                      : {}),
                    ...(parentOwnedAssuranceMode ? { revisionBoundAssurance: revisionBoundAssuranceLedger } : {}),
                    ...(parentOwnsCompletionLedger ? { deferCompletionLedger: true } : {}),
                    context: `${agentOrderContext(context, project, iteration, step.role, inputArtifacts, humanGuidance)}${verificationFailure
                      ? `\n\n## Deterministic verification failure from the previous attempt\n${verificationFailure}\nCorrect this failure before returning the next complete artifact set.`
                      : ''}`,
                    inputArtifacts,
                    supervisedBy: [...step.supervisedBy],
                    handsOffTo: downstreamRoles(step.role),
                    requiredDecisionIds: requiredHumanDecisionIds(humanGuidance, step.role),
                    executionContextVersion: resumeVersion,
                    ...(testPreview && (step.role === 'test'
                      || (revisionBoundAssuranceLedger && (step.role === 'reviewer' || step.role === 'gate')))
                      ? { preview: testPreview }
                      : {}),
                  };
                  if (step.role === 'gate') {
                    gateLedgerContext = { input, logicalOrderId: executionScope.orderId };
                  }
                  const commandOrderId = `${executionScope.orderId}:attempt${agentAttempt}`;
                  const execution = persistentActors
                    ? await executeThroughAgentActor(
                      input,
                      commandOrderId,
                      executionCheckpoint,
                    )
                    : scopedHumanDecisionResume && executionCheckpoint
                    ? await executeChild<typeof resumableAgentWorkflow>('resumableAgentWorkflow', {
                      workflowId: `${workflowInfo().workflowId}-i${iterationNumber}-run${executionRound}-${step.role}-graph-${agentAttempt}`,
                      ...(splitAgentTaskQueues ? { taskQueue: agentTaskQueue(step.role) } : {}),
                      args: [{
                        input,
                        modelRequestId: executionCheckpoint.executionId,
                        order: runtimeOrderForExecution(input, executionScope.orderId),
                        executionCheckpoint,
                      }],
                    })
                    : await executeChild(agentWorkflows[step.role], {
                      workflowId: `${workflowInfo().workflowId}-i${iterationNumber}-run${executionRound}-${step.role}-graph-${agentAttempt}`,
                      ...(splitAgentTaskQueues ? { taskQueue: agentTaskQueue(step.role) } : {}),
                      args: [input],
                    });
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
                  const candidate = 'draft' in execution
                    ? execution
                    : { draft: execution, artifacts: [], questionIds: [] };
                  await waitForAgentQuestions(candidate.questionIds, executionScope);
                  try {
                    if (step.role === 'builder' && builderPreflightBeforeHandoff) {
                      try {
                        await verifyBuilderRevisionBeforeHandoff();
                      } catch (error) {
                        if (correctiveArtifactOperationKeys) {
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
                    if (!defersCompletionUntilGateReadiness(
                      step.role,
                      completionAfterParentVerification,
                    )) {
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
                  if (durableHumanGuidanceEnabled || patched('flush-human-inputs-before-agent-block-v1')) {
                    await flushHumanInputs();
                  }
                  await waitForRetry(executionScope, retryToken);
                  await flushHumanInputs();
                }
              }
              return [step.role, result] as const;
            })());
          }
        }

        if (running.size === 0) throw new Error('The delivery graph contains an unresolved dependency cycle.');
        const [role, result] = await Promise.race(running.values());
        running.delete(role);
        completed.set(role, result);
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
        if (scopedHumanDecisionResume) {
          await waitForRetry(retryScope, retryToken);
        } else if (resumeVersion <= roundStartResumeVersion) {
          await condition(() => resumeVersion > roundStartResumeVersion);
        }
        await flushHumanInputs();
        continue;
      }
      if (completionAfterParentVerification && gate && gateLedgerContext) {
        await completeAgentLedgerAfterHandoff(
          gateLedgerContext.input,
          gate,
          gateLedgerContext.logicalOrderId,
        );
      }
      gateRationaleForProposal = gate?.draft.gateDecision?.rationale;
    }

    if (await reopenReviewAfterHumanGuidance(iterationNumber)) continue;

    if (!revisionBoundPreviews) {
      await projectActivities().setIterationStatus(project.id, iterationNumber, 'awaiting_review');
    }
    iteration = await projectActivities().prepareIterationReview(project, iterationNumber);
    if (!iteration.pullRequestNumber) throw new Error('Iteration review requires a pull request checkpoint.');
    // Resolve once more before review. New histories keep Test, Reviewer, and
    // Gate evidence in the ledger so this revision must remain the frozen
    // candidate; legacy histories may still have advanced the branch head.
    const reviewPreview = revisionBoundPreviews ? await deployMandatoryPreview() : undefined;
    if (revisionBoundAssuranceLedger
      && reviewPreview
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
    if (reviewProposalEnforcement && reviewPreview) {
      while (true) {
        try {
          const recording = await validation.captureUserFlow({ project, iteration, preview: reviewPreview });
          if (recording.revision !== reviewPreview.revision) {
            throw new Error('Final review evidence did not attest to the proposed preview revision.');
          }
          if (idempotentFinalReviewMedia) {
            await projectActivities().recordUserFlowMedia(
              project,
              iteration,
              recording,
              reviewPreview,
              `${project.id}:i${iterationNumber}:final-review-media:${reviewPreview.revision}`,
            );
          } else {
            await projectActivities().recordUserFlowMedia(project, iteration, recording, reviewPreview);
          }
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
    if (revisionBoundPreviews) {
      await projectActivities().setIterationStatus(project.id, iterationNumber, 'awaiting_review');
    }
    if (await reopenReviewAfterHumanGuidance(iterationNumber)) continue;
    reviewSequence += 1;
    activeReviewCheckpoint = createReviewCheckpoint(iteration, reviewSequence, reviewPreview, imageDigestAttestations);
    activeReviewProposal = undefined;
    let reviewProposal: IterationReviewProposal | undefined;
    if (patched('living-organism-review-proposal-v1') && activeReviewCheckpoint.previewRevision) {
      reviewProposal = reviewProposalEnforcement
        ? structuredGateProposalRationale
          ? await projectActivities().recordIterationReviewProposal(
            project.id,
            iterationNumber,
            activeReviewCheckpoint.previewRevision,
            reviewSequence,
            gateRationaleForProposal,
          )
          : await projectActivities().recordIterationReviewProposal(
          project.id,
          iterationNumber,
          activeReviewCheckpoint.previewRevision,
          reviewSequence,
        )
        : structuredGateProposalRationale
          ? await projectActivities().recordIterationReviewProposal(
            project.id,
            iterationNumber,
            activeReviewCheckpoint.previewRevision,
            undefined,
            gateRationaleForProposal,
          )
          : await projectActivities().recordIterationReviewProposal(
            project.id,
            iterationNumber,
            activeReviewCheckpoint.previewRevision,
          );
      if (!reviewCandidateInvalidated) activeReviewProposal = reviewProposal;
    }
    if (reviewCandidateInvalidated) {
      await reopenReviewAfterHumanGuidance(iterationNumber);
      continue;
    }
    if (reviewProposalEnforcement
      && reviewProposal
      && reviewProposal.recommendation !== 'send_for_human_review') {
      const cutoffResumeVersion = resumeVersion;
      const proposalAction = reviewProposalWorkflowAction(reviewProposal.recommendation);
      let continuationSafety: ReactiveContinuationSafetyAssessment | undefined;
      if (outerReactiveSafetyGuard && reviewProposal.recommendation === 'continue_iteration') {
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
      if (reactiveOrganismActivation) {
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
        autonomousReactiveContinuation,
      )) {
        await condition(() => pendingHumanInputs.length > 0 || resumeVersion > cutoffResumeVersion);
        await flushHumanInputs();
      }
      if (continueProjectAtReviewBoundary) await continueProjectWorkflow();
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
    if (revisionBoundPreviews && (!expectedPreviewRevision || (imageDigestAttestations && (!expectedPreviewImageDigest || !expectedPreviewExpiresAt)))) {
      throw new Error('Revision-bound review cannot proceed without active preview revision and image-digest evidence.');
    }
    pendingReview = undefined;
    pendingReviewIdempotencyKey = undefined;
    activeReviewCheckpoint = undefined;
    activeReviewProposal = undefined;
    processedReviewIdempotencyKeys.add(reviewIdempotencyKey);
    let lifecycle = revisionBoundPreviews && imageDigestAttestations
      ? await projectActivities().persistIterationReview(
        project.id,
        iterationNumber,
        decision,
        reviewIdempotencyKey,
        expectedPreviewRevision,
        expectedPreviewImageDigest,
      )
      : revisionBoundPreviews
      ? await projectActivities().persistIterationReview(
        project.id,
        iterationNumber,
        decision,
        reviewIdempotencyKey,
        expectedPreviewRevision,
      )
      : await projectActivities().persistIterationReview(
        project.id,
        iterationNumber,
        decision,
        reviewIdempotencyKey,
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
      lifecycle = revisionBoundPreviews && imageDigestAttestations
        ? await projectActivities().finalizeApprovedIterationDelivery(
          project.id,
          iterationNumber,
          reviewIdempotencyKey,
          expectedPreviewRevision,
          expectedPreviewImageDigest,
        )
        : revisionBoundPreviews
        ? await projectActivities().finalizeApprovedIterationDelivery(
          project.id,
          iterationNumber,
          reviewIdempotencyKey,
          expectedPreviewRevision,
        )
        : await projectActivities().finalizeApprovedIterationDelivery(
          project.id,
          iterationNumber,
          reviewIdempotencyKey,
        );
    }
    const explicitOverallDirection = decision.overallDirection?.trim() ?? '';
    const overallDirection = targetedReviewFeedbackActivation
      ? explicitOverallDirection
      : decision.overallDirection || decision.feedback;
    const artifactFeedbackRoles = new Map<string, AgentRole>();
    if (targetedReviewFeedbackActivation && !approved && (decision.artifactFeedback ?? []).some((feedback) => Boolean(feedback.feedback))) {
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
    if (reactiveOrganismActivation && !approved) {
      const directedRoles = (decision.agentFeedback ?? [])
        .filter((feedback) => Boolean(feedback.feedback))
        .map((feedback) => feedback.role);
      const artifactOwnerRoles = targetedArtifactFeedbackOwnerRoles(
        decision.artifactFeedback ?? [],
        artifactFeedbackRoles,
      );
      const hasBroadDirection = Boolean(overallDirection)
        || (!targetedReviewFeedbackActivation
          && (decision.artifactFeedback ?? []).some((feedback) => Boolean(feedback.feedback)));
      nextRoundRoles = targetedReviewFeedbackActivation
        ? targetedReviewReactivationRoles(overallDirection, directedRoles, artifactOwnerRoles)
        : hasBroadDirection
          ? iterationAgentGraph.map((definition) => definition.role)
          : reactiveIterationRoles(directedRoles);
    }
    if (reviewAdvancesIteration(decision.decision, lifecycle.merged)) iterationNumber += 1;
    context = `${context}\n\nHuman review: ${decision.decision}. ${overallDirection}`.slice(-24_000);
    if (continueProjectAtReviewBoundary) await continueProjectWorkflow();
  }
}

export async function listProjectsWorkflow(): Promise<ProjectSummary[]> {
  return projectActivities().listProjects();
}

export async function getProjectDetailWorkflow(projectId: string): Promise<ProjectDetail | undefined> {
  return projectActivities().getProjectDetail(projectId);
}
