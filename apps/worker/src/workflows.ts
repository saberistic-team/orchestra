import { PROJECT_ACTIVITY_TASK_QUEUE, VALIDATION_TASK_QUEUE, agentModelTaskQueue, agentTaskQueue, deliveryAgentGraph, previewAttestationSchema, type AgentArtifactDraft, type AgentArtifactReference, type AgentCommentInput, type AgentExecutionInput, type AgentMessage, type AgentQuestionAnswerInput, type AgentRole, type AgentWorkflowInput, type AgentWorkflowResult, type ArtifactFeedbackInput, type DeliveryAgentDefinition, type IterationReview, type IterationReviewSubmission, type PreviewDeploymentResult, type Project, type ProjectBrief, type ProjectDetail, type ProjectIteration, type ProjectSummary, type ReviewCheckpoint } from '@orchestra/contracts';
import { ParentClosePolicy, condition, continueAsNew, defineQuery, defineSignal, defineUpdate, executeChild, getExternalWorkflowHandle, makeContinueAsNewFunc, patched, proxyActivities, setHandler, startChild, workflowInfo } from '@temporalio/workflow';
import type * as activities from './activities.js';
import { bootstrapAgentState, dequeueNextMessage, enqueueMessage, getAgentCapabilities as getAgentCapabilitiesRuntime, getAgentStatus as getAgentStatusRuntime, recordInteraction, shouldContinueAsNew, type AgentBootstrap, type AgentCapabilityView, type AgentRuntimeState, type AgentStatusView } from './agent-runtime.js';

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

type ModelInteractionWorkflow = (input: AgentExecutionInput) => Promise<AgentArtifactDraft>;

async function executeAgent(
  input: AgentWorkflowInput,
  modelRequestId = `${workflowInfo().workflowId}/model`,
): Promise<AgentArtifactDraft | AgentWorkflowExecutionResult> {
  const graphHandoffs = patched('agent-artifact-handoffs-v1');
  if (graphHandoffs) {
    await projectActivities().recordAgentStarted(input.project, input.iteration, input.role, input.inputArtifacts ?? [], input.supervisedBy ?? []);
  } else {
    await projectActivities().recordAgentStarted(input.project, input.iteration, input.role);
  }
  const draft = patched('model-interaction-child-workflow-v1')
    ? await executeChild<ModelInteractionWorkflow>('modelInteractionWorkflow', {
      workflowId: modelRequestId,
      taskQueue: agentModelTaskQueue(input.role),
      args: [input],
    })
    : await legacyModel.runAgent(input);
  draft.name = input.artifactName;
  const recorded = await projectActivities().recordAgentArtifact(input.project, input.iteration, draft);
  if (input.role === 'test' && input.preview) {
    const recording = await validation.captureUserFlow({ project: input.project, iteration: input.iteration, preview: input.preview });
    if (recording.revision !== input.preview.revision) {
      throw new Error('User-flow recording did not attest to the requested preview revision.');
    }
    await projectActivities().recordUserFlowMedia(input.project, input.iteration, recording, input.preview);
  } else if (input.role === 'test' && input.project.previewUrl) {
    // Replay compatibility for Test workflows started before revision-bound previews.
    const recording = await validation.captureUserFlow({ project: input.project, iteration: input.iteration });
    await projectActivities().recordUserFlowMedia(input.project, input.iteration, recording);
  }
  if (!graphHandoffs) return draft;
  return { draft, artifacts: recorded.artifacts, questionIds: recorded.questionIds };
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
  input: AgentWorkflowInput;
  replyWorkflowId: string;
}

interface AgentExecutionResponse {
  orderId: string;
  role: AgentRole;
  result?: AgentWorkflowExecutionResult;
  error?: string;
}

type AgentExecutionCommand = AgentMessage<AgentExecutionCommandPayload>;

export const receiveAgentCommand = defineSignal<[AgentExecutionCommand]>('receiveMessage');
export const agentExecutionCompleted = defineSignal<[AgentExecutionResponse]>('agentExecutionCompleted');
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
  setHandler(getAgentStatus, () => getAgentStatusView(state));
  setHandler(getAgentCapabilities, () => getAgentCapabilitiesView(state));

  while (true) {
    await condition(() => state.mailbox.length > 0);
    const dequeued = dequeueNextMessage(state);
    state = dequeued.state;
    const message = dequeued.message;
    if (!message) continue;

    const payload = message.payload as AgentExecutionCommandPayload;
    try {
      const execution = await executeAgent(
        payload.input,
        `${workflowInfo().workflowId}/model/${payload.orderId}`,
      );
      const result: AgentWorkflowExecutionResult = 'draft' in execution
        ? execution
        : { draft: execution, artifacts: [], questionIds: [] };
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
      await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, {
        orderId: payload.orderId,
        role: state.role,
        result,
      });
    } catch (error) {
      state = recordInteraction(state, {
        id: `blocked:${message.messageId}`,
        messageId: message.messageId,
        correlationId: message.correlationId,
        iterationNumber: payload.input.iteration.number,
        from: 'system',
        to: [state.role],
        kind: 'control',
        name: `${state.role} order blocked`,
        summary: describeModelFailure(error),
        status: 'blocked',
        createdAt: new Date().toISOString(),
        live: true,
      });
      await getExternalWorkflowHandle(payload.replyWorkflowId).signal(agentExecutionCompleted, {
        orderId: payload.orderId,
        role: state.role,
        error: describeModelFailure(error),
      });
    }

    if (state.mailbox.length === 0 && shouldContinueAsNew(state)) {
      const recent = state.receivedMessages.slice(-100);
      const nextBootstrap: AgentBootstrap = {
        address: state.address,
        role: state.role,
        mode: state.mode,
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
  }
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
      id: artifact.id,
      type: artifact.type,
      name: artifact.name,
      content: artifact.content.slice(0, 8_000),
      mimeType: artifact.mimeType,
      producedBy: artifact.producedBy,
      repositoryUrl: artifact.repositoryUrl,
    }));
}

export interface GateReadiness {
  ready: boolean;
  reasons: string[];
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
    `\n\n## Handoff from ${artifact.producedBy}: ${artifact.name}\nType: ${artifact.type}\nForgejo: ${artifact.repositoryUrl ?? 'pending'}\n${artifact.content}`,
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

function isReviewSubmission(value: IterationReview | IterationReviewSubmission): value is IterationReviewSubmission {
  return typeof value === 'object' && value !== null && 'review' in value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
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
export const resumeProject = defineSignal('resumeProject');
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

export async function projectWorkflow(project: Project, creatorWorkflowId?: string) {
  let pendingReview: IterationReview | undefined;
  let pendingReviewIdempotencyKey: string | undefined;
  let activeReviewCheckpoint: ReviewCheckpoint | undefined;
  let reviewSequence = 0;
  const processedReviewIdempotencyKeys = new Set<string>();
  let resumeVersion = 0;
  let decisionReconciliationRequested = true;
  let durableHumanGuidanceEnabled = false;
  let state = 'discovering';
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
  setHandler(approveBrief, () => { receiveReview({ decision: 'approved', feedback: '' }); });
  setHandler(reviewIteration, receiveReview);
  setHandler(resumeProject, () => {
    decisionReconciliationRequested = true;
    resumeVersion += 1;
  });
  setHandler(enableDurableHumanGuidance, () => {
    durableHumanGuidanceEnabled = true;
    decisionReconciliationRequested = true;
    resumeVersion += 1;
  });
  setHandler(answerAgentQuestion, (value) => {
    pendingHumanInputs.push({ kind: 'question_answer', value });
    decisionReconciliationRequested = true;
    resumeVersion += 1;
  });
  setHandler(answerAgentQuestionAndWait, async (value) => {
    pendingHumanInputs.push({ kind: 'question_answer', value });
    decisionReconciliationRequested = true;
    resumeVersion += 1;
    // Unlike the legacy fire-and-forget Signal, an Update does not acknowledge
    // the HTTP request until the durable database answer exists.
    await flushHumanInputs();
  });
  setHandler(commentOnAgent, (value) => {
    if (value.projectId !== project.id) return;
    pendingHumanInputs.push({ kind: 'agent_comment', value });
  });
  setHandler(commentOnArtifact, (value) => {
    pendingHumanInputs.push({ kind: 'artifact_feedback', value });
  });
  setHandler(agentExecutionCompleted, (response) => { agentResponses.set(response.orderId, response); });
  setHandler(projectState, () => state);
  setHandler(projectDetails, () => project);
  setHandler(getReviewCheckpoint, () => activeReviewCheckpoint);

  if (creatorWorkflowId) {
    await getExternalWorkflowHandle(creatorWorkflowId).signal(projectReady);
  }

  project = await projectActivities().connectProjectRepository(project);

  async function flushHumanInputs(): Promise<void> {
    if ((canonicalHumanDecisions || patched('canonical-human-decisions-live-reconcile-v2'))
      && decisionReconciliationRequested) {
      await projectActivities().reconcileAgentQuestionDecisions(project.id);
      decisionReconciliationRequested = false;
    }
    while (pendingHumanInputs.length > 0) {
      const item = pendingHumanInputs.shift()!;
      if (item.kind === 'question_answer') {
        const answered = await projectActivities().persistAgentQuestionAnswer(project.id, item.value.questionId, item.value.answer);
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
          role: answered.agentRole,
          summary: `Answer to “${answered.question}”: ${answer}`,
        });
      } else if (item.kind === 'agent_comment') {
        await projectActivities().persistAgentComment(item.value);
        humanGuidance.push({
          key: `agent-comment:${item.value.agentRole}:${humanGuidance.length}`,
          kind: 'agent_comment',
          role: item.value.agentRole,
          summary: item.value.body,
        });
      } else {
        const role = await projectActivities().persistArtifactFeedback(project.id, item.value);
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
        await projectActivities().getProjectHumanGuidance(project.id),
      );
    }
  }

  async function waitForAgentQuestions(questionIds: readonly string[]): Promise<void> {
    if (questionIds.length === 0) return;
    while (!(await projectActivities().areAgentQuestionsAnswered(project.id, questionIds))) {
      await condition(() => pendingHumanInputs.length > 0);
      await flushHumanInputs();
    }
  }

  const persistentActors = patched('persistent-agent-actors-v1');
  const splitAgentTaskQueues = patched('split-agent-task-queues-v1');
  const revisionBoundPreviews = patched('revision-bound-mandatory-preview-v1');
  const imageDigestAttestations = patched('preview-image-digest-attestation-v1');
  const canonicalHumanDecisions = patched('canonical-human-decisions-v1');
  if (persistentActors) {
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

  async function executeThroughAgentActor(input: AgentWorkflowInput, orderId: string): Promise<AgentWorkflowExecutionResult> {
    const recipientWorkflowId = agentWorkflowId(project.id, input.role);
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
      authority: {
        grantId: `iteration:${input.iteration.id}:${input.role}`,
        issuerRole: 'manager',
        level: 'ITERATION',
        permittedActions: ['EXECUTE_BOUNDED_STEP'],
        permittedTargets: [input.role],
        scopeRefs: [input.iteration.id, input.artifactType],
        mayDelegate: false,
      },
      payload: { orderId, input, replyWorkflowId: workflowInfo().workflowId },
      acknowledgementRequired: true,
      createdAt: new Date().toISOString(),
    };
    await getExternalWorkflowHandle(recipientWorkflowId).signal(receiveAgentCommand, message);
    await condition(() => agentResponses.has(orderId));
    const response = agentResponses.get(orderId)!;
    agentResponses.delete(orderId);
    if (response.error) throw new Error(response.error);
    if (!response.result) throw new Error(`${input.role} returned no workflow result.`);
    return response.result;
  }

  let iterationNumber = project.currentIteration;
  let executionRound = 0;
  let context = `Intent: ${project.intent}\nAudience: ${project.audience}\nSuccess: ${project.success}\nConstraints: ${project.constraints.join('; ')}`;

  while (true) {
    executionRound += 1;
    const roundStartResumeVersion = resumeVersion;
    let iteration = await projectActivities().getIteration(project.id, iterationNumber);
    iteration = await projectActivities().prepareIterationRepository(project, iteration);
    await flushHumanInputs();
    let previewAttempted = false;
    let testPreview: PreviewDeploymentResult | undefined;

    const deployMandatoryPreview = async (): Promise<PreviewDeploymentResult> => {
      while (true) {
        try {
          const deployed = revisionBoundPreview(await validation.deployIterationPreview({ project, iteration }));
          project = await projectActivities().recordIterationPreview(project, iteration, deployed);
          return deployed;
        } catch (error) {
          state = 'blocked';
          await projectActivities().setProjectStatus(project.id, 'blocked');
          await projectActivities().setIterationStatus(project.id, iterationNumber, 'blocked');
          await projectActivities().recordPreviewUnavailable(project.id, iteration.number, describeModelFailure(error));
          const failedAtVersion = resumeVersion;
          await condition(() => resumeVersion > failedAtVersion);
          await flushHumanInputs();
        }
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
        const preview = step.role === 'test' ? await ensureIterationPreview() : undefined;
        state = step.status;
        await projectActivities().setProjectStatus(project.id, step.status);
        let draft: AgentArtifactDraft | undefined;
        let agentAttempt = 0;
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
            const result = await executeChild(agentWorkflows[step.role], {
              workflowId: `${workflowInfo().workflowId}-i${iterationNumber}-${step.role}-${agentAttempt}`,
              ...(splitAgentTaskQueues ? { taskQueue: agentTaskQueue(step.role) } : {}),
              args: [{
                project,
                iteration,
                role: step.role,
                artifactType: step.artifactType,
                artifactName: step.artifactName,
                context: agentOrderContext(context, project, iteration, step.role, priorArtifacts, humanGuidance),
                inputArtifacts: priorArtifacts,
                ...(preview ? { preview } : {}),
              }],
            });
            if ('draft' in result) {
              await waitForAgentQuestions(result.questionIds);
              await projectActivities().recordAgentHandoff(
                project,
                iteration,
                step.role,
                result.artifacts,
                downstreamRoles(step.role),
              );
              draft = result.draft;
            } else {
              draft = result;
            }
          } catch (error) {
            state = 'blocked';
            await projectActivities().setProjectStatus(project.id, 'blocked');
            await projectActivities().recordAgentFailure(project.id, iterationNumber, step.role, describeModelFailure(error));
            const failedAtVersion = resumeVersion;
            await condition(() => resumeVersion > failedAtVersion);
            await flushHumanInputs();
          }
        }
        context = `${context}\n\n## ${draft.name}\n${draft.content}`.slice(-24_000);
      }
    } else {
      const completed = new Map<AgentRole, AgentWorkflowExecutionResult>();
      const executionInputs = new Map<AgentRole, AgentArtifactReference[]>();
      const remaining = new Set<AgentRole>(iterationAgentGraph.map((step) => step.role));
      const running = new Map<AgentRole, Promise<readonly [AgentRole, AgentWorkflowExecutionResult]>>();

      while (remaining.size > 0 || running.size > 0) {
        await flushHumanInputs();
        const ready = iterationAgentGraph.filter((step) =>
          remaining.has(step.role) && step.dependsOn.every((dependency) => completed.has(dependency)),
        );
        if (ready.length > 0) {
          if (ready.some((step) => step.role === 'test')) await ensureIterationPreview();
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
            );
            const inputArtifacts = mergeAgentArtifactContext(collectInputArtifacts(step, completed), priorArtifacts);
            executionInputs.set(step.role, inputArtifacts);
            running.set(step.role, (async () => {
              let result: AgentWorkflowExecutionResult | undefined;
              let agentAttempt = 0;
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
                    context: agentOrderContext(context, project, iteration, step.role, inputArtifacts, humanGuidance),
                    inputArtifacts,
                    supervisedBy: [...step.supervisedBy],
                    handsOffTo: downstreamRoles(step.role),
                    ...(step.role === 'test' && testPreview ? { preview: testPreview } : {}),
                  };
                  if (persistentActors) {
                    result = await executeThroughAgentActor(
                      input,
                      `${project.id}:i${iterationNumber}:run${executionRound}:${step.role}:attempt${agentAttempt}`,
                    );
                  } else {
                    const childResult = await executeChild(agentWorkflows[step.role], {
                      workflowId: `${workflowInfo().workflowId}-i${iterationNumber}-run${executionRound}-${step.role}-graph-${agentAttempt}`,
                      ...(splitAgentTaskQueues ? { taskQueue: agentTaskQueue(step.role) } : {}),
                      args: [input],
                    });
                    result = 'draft' in childResult ? childResult : { draft: childResult, artifacts: [], questionIds: [] };
                  }
                } catch (error) {
                  state = 'blocked';
                  await projectActivities().setProjectStatus(project.id, 'blocked');
                  await projectActivities().recordAgentFailure(project.id, iterationNumber, step.role, describeModelFailure(error));
                  // Human answers/comments can arrive while the role actor is
                  // still finishing. Persist them before capturing the blocked
                  // resume version so a later actor failure cannot strand an
                  // accepted UI submission in workflow memory.
                  if (durableHumanGuidanceEnabled || patched('flush-human-inputs-before-agent-block-v1')) {
                    await flushHumanInputs();
                  }
                  const failedAtVersion = resumeVersion;
                  await condition(() => resumeVersion > failedAtVersion);
                  await flushHumanInputs();
                }
              }
              await waitForAgentQuestions(result.questionIds);
              await projectActivities().recordAgentHandoff(
                project,
                iteration,
                step.role,
                result.artifacts,
                downstreamRoles(step.role),
              );
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
        state = 'blocked';
        await projectActivities().setProjectStatus(project.id, 'blocked');
        await projectActivities().setIterationStatus(project.id, iterationNumber, 'blocked');
        await projectActivities().recordAgentFailure(
          project.id,
          iterationNumber,
          'gate',
          gateReadiness.reasons.join(' '),
        );
        if (resumeVersion <= roundStartResumeVersion) {
          await condition(() => resumeVersion > roundStartResumeVersion);
        }
        await flushHumanInputs();
        continue;
      }
    }

    if (!revisionBoundPreviews) {
      await projectActivities().setIterationStatus(project.id, iterationNumber, 'awaiting_review');
    }
    iteration = await projectActivities().prepareIterationReview(project, iterationNumber);
    if (!iteration.pullRequestNumber) throw new Error('Iteration review requires a pull request checkpoint.');
    // Assurance artifacts are committed after the pre-Test deployment. Resolve
    // and deploy once more so the human checkpoint is bound to the final PR head.
    const reviewPreview = revisionBoundPreviews ? await deployMandatoryPreview() : undefined;
    if (revisionBoundPreviews) {
      await projectActivities().setIterationStatus(project.id, iterationNumber, 'awaiting_review');
    }
    reviewSequence += 1;
    activeReviewCheckpoint = createReviewCheckpoint(iteration, reviewSequence, reviewPreview, imageDigestAttestations);
    state = 'awaiting_approval';
    await projectActivities().setProjectStatus(project.id, 'awaiting_approval');
    while (!pendingReview) {
      await condition(() => pendingReview !== undefined || pendingHumanInputs.length > 0);
      await flushHumanInputs();
    }
    const decision = pendingReview!;
    const reviewIdempotencyKey = pendingReviewIdempotencyKey!;
    const acceptedReviewCheckpoint = activeReviewCheckpoint;
    const expectedPreviewRevision = acceptedReviewCheckpoint?.previewRevision;
    const expectedPreviewImageDigest = acceptedReviewCheckpoint?.previewImageDigest;
    const expectedPreviewExpiresAt = acceptedReviewCheckpoint?.previewExpiresAt;
    if (revisionBoundPreviews && (!expectedPreviewRevision || (imageDigestAttestations && (!expectedPreviewImageDigest || !expectedPreviewExpiresAt)))) {
      throw new Error('Revision-bound review cannot proceed without active preview revision and image-digest evidence.');
    }
    pendingReview = undefined;
    pendingReviewIdempotencyKey = undefined;
    activeReviewCheckpoint = undefined;
    processedReviewIdempotencyKeys.add(reviewIdempotencyKey);
    await flushHumanInputs();
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
      state = 'blocked';
      await projectActivities().setProjectStatus(project.id, 'blocked');
      await projectActivities().recordAgentFailure(project.id, iterationNumber, 'gate', 'The iteration is approved, but Forgejo did not confirm the pull request merge.');
      const failedAtVersion = resumeVersion;
      await condition(() => resumeVersion > failedAtVersion);
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
    const overallDirection = decision.overallDirection || decision.feedback;
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
        summary: `Artifact ${feedback.artifactId}: ${feedback.feedback}`,
      });
    }
    if (reviewAdvancesIteration(decision.decision, lifecycle.merged)) iterationNumber += 1;
    context = `${context}\n\nHuman review: ${decision.decision}. ${overallDirection}`.slice(-24_000);
  }
}

export async function listProjectsWorkflow(): Promise<ProjectSummary[]> {
  return projectActivities().listProjects();
}

export async function getProjectDetailWorkflow(projectId: string): Promise<ProjectDetail | undefined> {
  return projectActivities().getProjectDetail(projectId);
}
