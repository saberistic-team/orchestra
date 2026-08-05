import { artifactContentAddress, deliveryAgentGraph, resolveModelConcurrency, type AgentArtifactDraft, type AgentArtifactReference, type AgentCommentInput, type AgentExecutionGraph, type AgentInteraction, type AgentInteractionKind, type AgentInteractionParty, type AgentInteractionStatus, type AgentMessage, type AgentOrder, type AgentQuestion, type AgentQuestionAnswerInput, type AgentRole, type AgentRuntimeSnapshot, type ArtifactFeedbackInput, type DeliveryAgentDefinition, type DynamicExecutionTrace, type DynamicHumanDecisionRequest, type IterationReadiness, type IterationReview, type IterationReviewProposal, type MessageThread, type PreviewDeploymentResult, type Project, type ProjectArtifact, type ProjectBrief, type ProjectDetail, type ProjectEvent, type ProjectIteration, type ProjectStatus, type ProjectSummary } from '@orchestra/contracts';
import { resolveModelProvider } from '@orchestra/contracts';
import { defaultMigrationsFolder, normalizeDecisionKey, ProjectStore, type ArtifactOperationRecoveryEnvelope, type RecordAgentRuntimeStateInput } from '@orchestra/database';
import { createHash } from 'node:crypto';
import { addIterationComment, addIterationCommentOnce, agentCommitSummary, applyIterationReviewLifecycle, commitArtifact, createForgejoLifecycleAdapter, createIterationIssue, createIterationPullRequest, ensureProjectLifecycleLabels, ensureProjectRepository, labelIterationAgent, labelIterationStatus, type ForgejoIterationLifecycleResult } from './forgejo.js';
import { interactionFromOrganismEvent, projectOrganismEvents } from './organism-event-projection.js';

let projectStore: ProjectStore | undefined;
let migration: Promise<void> | undefined;

async function store() {
  projectStore ??= new ProjectStore(
    process.env.DATABASE_URL ?? 'postgresql://orchestra:orchestra@localhost:5432/orchestra',
  );
  migration ??= projectStore.migrate(process.env.DRIZZLE_MIGRATIONS_PATH ?? defaultMigrationsFolder);
  await migration;
  return projectStore;
}

export async function createProject(brief: ProjectBrief): Promise<Project> {
  return (await store()).create(brief);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return (await store()).list();
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail | undefined> {
  const detail = await (await store()).detail(projectId);
  if (!detail) return undefined;
  const projected = { ...detail, organismEvents: projectOrganismEvents(detail) };
  return { ...projected, executionGraph: buildExecutionGraph(projected) };
}

export async function persistAgentMessage(message: AgentMessage): Promise<AgentInteraction> {
  return (await store()).recordAgentMessage(message);
}

export async function transitionAgentMessage(
  projectId: string,
  idempotencyKey: string,
  transition: 'delivered' | 'acknowledged' | 'completed' | 'failed',
  recipientRole?: AgentRole | 'human' | 'system',
): Promise<AgentInteraction | undefined> {
  return (await store()).transitionAgentMessage(projectId, idempotencyKey, transition, recipientRole);
}

export async function persistAgentRuntimeState(
  input: RecordAgentRuntimeStateInput,
): Promise<AgentRuntimeSnapshot> {
  return (await store()).recordAgentRuntimeState(input);
}

export async function persistAgentOrderLedger(
  projectId: string,
  iterationId: string,
  role: AgentRole,
  order: AgentOrder,
  correlationId: string,
  sourceRevision?: string,
): Promise<void> {
  await (await store()).recordAgentOrderLedger(
    projectId,
    iterationId,
    role,
    order,
    correlationId,
    sourceRevision,
  );
}

export async function persistAgentExecutionLedger(
  projectId: string,
  iterationId: string,
  role: AgentRole,
  order: AgentOrder,
  status: 'completed' | 'waiting_for_human' | 'blocked' | 'budget_exhausted',
  trace: DynamicExecutionTrace | undefined,
  artifactIds: string[],
  correlationId: string,
  sourceRevision?: string,
  failureReason?: string,
): Promise<void> {
  await (await store()).recordAgentExecutionLedger(
    projectId,
    iterationId,
    role,
    order,
    status,
    trace,
    artifactIds,
    correlationId,
    sourceRevision,
    failureReason,
  );
}

export interface StoredHumanGuidance {
  key: string;
  kind: 'question_answer' | 'agent_comment' | 'artifact_feedback' | 'overall_direction' | 'agent_feedback';
  summary: string;
  role?: AgentRole;
}

export interface StoredHumanGuidancePageRequest {
  afterKey?: string;
  limit?: number;
}

export interface StoredHumanGuidancePage {
  entries: StoredHumanGuidance[];
  nextCursor?: string;
}

export function paginateStoredHumanGuidance(
  guidance: readonly StoredHumanGuidance[],
  request: StoredHumanGuidancePageRequest,
): StoredHumanGuidancePage {
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Human guidance page size must be an integer between 1 and 100.');
  }
  const ordered = [...guidance].sort((left, right) => left.key.localeCompare(right.key));
  const start = request.afterKey
    ? ordered.findIndex((entry) => entry.key > request.afterKey!)
    : 0;
  if (start < 0) return { entries: [] };
  const entries = ordered.slice(start, start + limit);
  const hasMore = start + entries.length < ordered.length;
  return {
    entries,
    ...(hasMore && entries.length > 0 ? { nextCursor: entries.at(-1)!.key } : {}),
  };
}

export function humanGuidanceFromProjectDetail(detail: ProjectDetail): StoredHumanGuidance[] {
  const guidance: StoredHumanGuidance[] = [];
  const decisions = new Map<string, AgentQuestion>();
  for (const question of [...(detail.questions ?? [])].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    if (question.status !== 'answered' || !question.answer) continue;
    const key = normalizeDecisionKey(question.decisionKey);
    if (!decisions.has(key)) decisions.set(key, question);
  }
  for (const [decisionKey, question] of decisions) {
    const answer = question.answer!;
    const answerText = answer.resolution === 'custom'
      ? answer.answer
      : answer.resolution === 'agent_decides'
        ? 'The human authorized the responsible agent to decide within the approved scope.'
        : (() => {
            const selected = question.options.find((option) => option.id === answer.optionId);
            return selected
              ? `${selected.label}${selected.description ? ` — ${selected.description}` : ` (${selected.value})`}`
              : 'The human selected an available option.';
          })();
    guidance.push({
      key: `decision:${decisionKey}`,
      kind: 'question_answer',
      summary: `[${decisionKey}] ${question.question} Answer: ${answerText} Treat this as an existing project decision; do not ask it again with different wording.`,
    });
  }
  for (const comment of (detail.agentComments ?? []).filter((item) => item.authorType === 'human')) {
    guidance.push({
      key: `agent-comment:${comment.id}`,
      kind: 'agent_comment',
      role: comment.agentRole,
      summary: comment.body,
    });
  }
  const artifacts = new Map(detail.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const feedback of detail.artifactFeedback ?? []) {
    if (!feedback.feedback) continue;
    const artifact = artifacts.get(feedback.artifactId);
    guidance.push({
      key: `artifact-feedback:${feedback.id}`,
      kind: 'artifact_feedback',
      ...(artifact ? { role: artifact.producedBy } : {}),
      summary: `${artifact?.name ?? feedback.artifactId} (${artifact?.producedBy ?? 'unknown'}): ${feedback.feedback}`,
    });
  }
  for (const review of detail.iterationReviews ?? []) {
    const direction = review.overallDirection || review.feedback;
    if (direction) guidance.push({
      key: `review:${review.id}:overall`,
      kind: 'overall_direction',
      summary: `Iteration ${review.iterationNumber}: ${direction}`,
    });
    for (const feedback of review.agentFeedback) {
      if (!feedback.feedback) continue;
      guidance.push({
        key: `review:${review.id}:agent:${feedback.role}`,
        kind: 'agent_feedback',
        role: feedback.role,
        summary: `Iteration ${review.iterationNumber}: ${feedback.feedback}`,
      });
    }
  }
  return guidance;
}

/**
 * Rebuilds model-facing human context from durable project records. Decisions
 * are project-wide and the latest answer for a canonical key is authoritative;
 * role comments and iteration agent feedback remain scoped to that role.
 */
export async function getProjectHumanGuidance(
  projectId: string,
  page?: StoredHumanGuidancePageRequest,
): Promise<StoredHumanGuidance[] | StoredHumanGuidancePage> {
  const detail = await (await store()).detail(projectId);
  if (!detail) return page ? { entries: [] } : [];
  const guidance = humanGuidanceFromProjectDetail(detail);
  // Histories created before paged-human-guidance-v1 invoked this Activity
  // with only projectId and must continue receiving the original array shape.
  return page ? paginateStoredHumanGuidance(guidance, page) : guidance;
}

function artifactTypeMatches(pattern: string, type: string) {
  return pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}

/**
 * Selects the newest relevant durable artifact versions. Current-iteration
 * evidence is opt-in for reactive rounds so lifecycle status cannot silently
 * remove unscheduled upstream context. Kept pure for boundary tests.
 */
export function selectPriorAgentArtifacts(
  detail: ProjectDetail,
  iterationNumber: number,
  consumes: readonly string[],
  options: { includeCurrentIteration?: boolean } = {},
): AgentArtifactReference[] {
  const iterationNumbers = new Map(detail.iterations.map((iteration) => [iteration.id, iteration.number]));
  const revisingCurrentIteration = detail.iterations.some((iteration) =>
    iteration.number === iterationNumber
      && (iteration.status === 'changes_requested' || iteration.status === 'blocked'));
  const includeCurrentIteration = options.includeCurrentIteration === true || revisingCurrentIteration;
  const selected = detail.artifacts
    .filter((artifact) => artifact.status === 'ready_for_review'
      || artifact.status === 'approved'
      || (includeCurrentIteration && artifact.status === 'changes_requested'))
    .filter((artifact) => {
      const artifactIteration = iterationNumbers.get(artifact.iterationId) ?? iterationNumber;
      return artifactIteration < iterationNumber || (includeCurrentIteration && artifactIteration === iterationNumber);
    })
    .filter((artifact) => consumes.some((pattern) => artifactTypeMatches(pattern, artifact.type)))
    .sort((left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt));
  const newestByType = new Map<string, ProjectArtifact>();
  for (const artifact of selected) {
    if (!newestByType.has(artifact.type)) newestByType.set(artifact.type, artifact);
  }
  return [...newestByType.values()].slice(0, 20).map(toAgentArtifactReference);
}

export function toAgentArtifactReference(artifact: ProjectArtifact): AgentArtifactReference {
  return {
    id: artifact.id,
    type: artifact.type,
    name: artifact.name,
    version: artifact.version,
    mimeType: artifact.mimeType,
    producedBy: artifact.producedBy,
    contentAddress: artifactContentAddress(artifact.projectId, artifact.id, artifact.version),
    contentHash: `sha256:${createHash('sha256').update(artifact.content).digest('hex')}`,
    byteLength: Buffer.byteLength(artifact.content, 'utf8'),
    repositoryPath: artifact.repositoryPath,
    repositoryUrl: artifact.repositoryUrl,
  };
}

export async function getPriorAgentArtifacts(
  projectId: string,
  iterationNumber: number,
  consumes: readonly string[],
  options: { includeCurrentIteration?: boolean } = {},
): Promise<AgentArtifactReference[]> {
  const detail = await (await store()).detail(projectId);
  return detail ? selectPriorAgentArtifacts(detail, iterationNumber, consumes, options) : [];
}

export function buildExecutionGraph(detail: ProjectDetail): AgentExecutionGraph {
  const iterationNumber = detail.project.currentIteration;
  const iteration = detail.iterations.find((candidate) => candidate.number === iterationNumber);
  const artifacts = detail.artifacts.filter((artifact) =>
    artifact.iterationId === iteration?.id
      && (artifact.status === 'ready_for_review' || artifact.status === 'approved'));
  const events = detail.events.filter((event) => event.iterationNumber === iterationNumber);
  const questions = (detail.questions ?? []).filter((question) => question.iterationId === iteration?.id || question.iterationId === null);
  const completedRoles = new Set(deliveryAgentGraph.filter((step) =>
    artifacts.some((artifact) => artifact.producedBy === step.role && artifact.type === step.artifactType),
  ).map((step) => step.role));
  const interactions = buildAgentInteractions(detail, completedRoles);
  const runtimeByRole = new Map((detail.agentRuntimeSnapshots ?? []).map((snapshot) => [snapshot.role, snapshot]));

  const nodes = deliveryAgentGraph.map((step) => {
    const runtime = runtimeByRole.get(step.role);
    const roleArtifacts = artifacts
      .filter((artifact) => artifact.producedBy === step.role)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const completedArtifact = roleArtifacts.find((artifact) => artifact.type === step.artifactType);
    const roleEvents = events
      .filter((event) => event.agentRole === step.role)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const startedEvent = roleEvents.find((event) => event.kind === 'agent' && /started|working|running|in progress/iu.test(`${event.title} ${event.description}`));
    const failedEvent = roleEvents.find((event) => event.kind === 'system' && /block|fail|needs attention|cannot|unavailable/iu.test(`${event.title} ${event.description}`));
    const pendingQuestion = questions.find((question) => question.agentRole === step.role && question.status === 'pending');
    const completedAfterStart = completedArtifact && (!startedEvent || completedArtifact.createdAt >= startedEvent.createdAt);
    const failedAfterStart = failedEvent && (!startedEvent || failedEvent.createdAt >= startedEvent.createdAt);
    const awaitsReleaseAuthorization = (step as DeliveryAgentDefinition).activation === 'authorized_release' && !startedEvent && !completedArtifact;
    const unmetDependencies = step.dependsOn.filter((dependency) => !completedRoles.has(dependency));
    const inferredState: AgentExecutionGraph['nodes'][number]['state'] = pendingQuestion ? 'waiting_on_human'
      : failedAfterStart ? 'blocked'
        : startedEvent && !completedAfterStart ? activeStateForRole(step.role)
          : completedAfterStart
            ? iteration?.status === 'awaiting_review' || iteration?.status === 'approved' || iteration?.status === 'completed'
              ? 'completed_for_iteration'
              : 'monitoring'
            : awaitsReleaseAuthorization ? 'monitoring'
              : unmetDependencies.length === 0 ? 'ready' : 'waiting_on_agent';
    const state = runtime?.state ?? inferredState;
    const inferredStateChangedAt = pendingQuestion?.updatedAt
      ?? failedEvent?.createdAt
      ?? (startedEvent && !completedAfterStart ? startedEvent.createdAt : undefined)
      ?? completedArtifact?.createdAt
      ?? iteration?.startedAt
      ?? null;
    const stateChangedAt = runtime?.stateChangedAt ?? inferredStateChangedAt;
    const roleInteractions = interactions.filter((interaction) => interaction.from === step.role || interaction.to.includes(step.role));
    const liveMessages = roleInteractions.filter((interaction) => interaction.live || ['pending', 'acknowledged', 'in_progress', 'blocked'].includes(interaction.status));
    const modelUsage = summarizeRoleModelUsage(detail, iteration?.id, step.role, roleArtifacts);
    const durableFinding = (detail.findings ?? [])
      .filter((finding) => finding.iterationId === iteration?.id
        && (finding.raisedByRole === step.role || finding.ownerRole === step.role))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const latestFinding = durableFinding?.title
      ?? roleInteractions.find((interaction) => interaction.kind === 'finding' || interaction.kind === 'blocker')?.summary;
    return {
      role: step.role,
      label: step.label,
      icon: step.icon,
      phase: step.phase,
      state,
      activity: runtime?.activity ?? {
        type: activityTypeForRole(step.role, state),
        summary: activitySummaryForNode(step, state, {
          pendingQuestion: pendingQuestion?.question,
          failedSummary: failedEvent?.description,
          unmetDependencies,
          eventSummary: startedEvent?.description,
        }),
        startedAt: state === 'planning' || state === 'working' || state === 'reviewing'
          ? startedEvent?.createdAt ?? null
          : stateChangedAt,
      },
      stateChangedAt,
      assignedModel: completedArtifact?.model ?? 'resolved when agent starts',
      assignedProvider: completedArtifact?.modelProvider ?? resolveModelProvider(step.role, process.env),
      artifactType: step.artifactType,
      artifactName: step.artifactName,
      dependsOn: [...step.dependsOn],
      supervisedBy: [...step.supervisedBy],
      consumes: [...step.consumes],
      produces: [...step.produces],
      startedAt: runtime?.activity?.startedAt ?? startedEvent?.createdAt ?? null,
      completedAt: completedArtifact?.createdAt ?? null,
      tokenUse: modelUsage.tokens,
      openRouterCost: modelUsage.cost,
      openMessageCount: runtime?.mailboxDepth ?? liveMessages.filter((interaction) => interaction.to.includes(step.role)).length,
      blockingDependencyCount: runtime?.blockerCount ?? unmetDependencies.length + (state === 'blocked' ? 1 : 0),
      humanAttention: state === 'waiting_on_human',
      latestArtifact: roleArtifacts[0]?.name,
      latestFinding,
    };
  });
  const edges: AgentExecutionGraph['edges'] = [];
  for (const target of deliveryAgentGraph) {
    for (const sourceRole of target.dependsOn) {
      const source = deliveryAgentGraph.find((candidate) => candidate.role === sourceRole)!;
      const traffic = interactionsBetween(interactions, sourceRole, target.role);
      edges.push({
        id: `dependency:${sourceRole}:${target.role}`,
        from: sourceRole,
        to: target.role,
        kind: 'blocks',
        artifacts: source.produces.filter((produced) => target.consumes.some((consumed) =>
          artifactTypeMatches(consumed, produced) || artifactTypeMatches(produced, consumed),
        )),
        label: 'Required handoff',
        messageCount: traffic.length,
        activeMessageIds: traffic.filter((interaction) => interaction.live).map((interaction) => interaction.id),
        correlationIds: [...new Set(traffic.map((interaction) => interaction.correlationId).filter((value): value is string => Boolean(value)))],
        lastMessageAt: traffic[0]?.createdAt ?? null,
      });
    }
    for (const supervisor of target.supervisedBy) {
      if (!edges.some((edge) => edge.from === supervisor && edge.to === target.role && edge.kind === 'supervises')) {
        const traffic = interactionsBetween(interactions, supervisor, target.role);
        edges.push({
          id: `supervision:${supervisor}:${target.role}`,
          from: supervisor,
          to: target.role,
          kind: 'supervises',
          artifacts: [],
          label: 'Guidance and escalation',
          messageCount: traffic.length,
          activeMessageIds: traffic.filter((interaction) => interaction.live).map((interaction) => interaction.id),
          correlationIds: [...new Set(traffic.map((interaction) => interaction.correlationId).filter((value): value is string => Boolean(value)))],
          lastMessageAt: traffic[0]?.createdAt ?? null,
        });
      }
    }
  }
  for (const interaction of interactions) {
    if (!isAgentRoleParty(interaction.from)) continue;
    for (const recipient of interaction.to.filter(isAgentRoleParty)) {
      if (edges.some((edge) => edge.from === interaction.from && edge.to === recipient)) continue;
      const traffic = interactionsBetween(interactions, interaction.from, recipient);
      edges.push({
        id: `communication:${interaction.from}:${recipient}`,
        from: interaction.from,
        to: recipient,
        kind: 'communicates',
        artifacts: [],
        label: 'Message flow',
        messageCount: traffic.length,
        activeMessageIds: traffic.filter((item) => item.live).map((item) => item.id),
        correlationIds: [...new Set(traffic.map((item) => item.correlationId).filter((value): value is string => Boolean(value)))],
        lastMessageAt: traffic[0]?.createdAt ?? null,
      });
    }
  }
  return {
    iterationNumber,
    graphVersion: 1,
    nodes,
    edges,
    modelConcurrency: resolveModelConcurrency(
      process.env,
      deliveryAgentGraph.some((step) => resolveModelProvider(step.role, process.env) === 'openrouter') ? 'openrouter' : 'ollama',
    ),
    interactions,
    threads: buildMessageThreads(interactions),
    readiness: buildIterationReadiness(detail, nodes, interactions),
  };
}

function activeStateForRole(role: AgentRole): AgentExecutionGraph['nodes'][number]['state'] {
  if (['test', 'reviewer', 'gate', 'validation'].includes(role)) return 'reviewing';
  if (['manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security', 'planner'].includes(role)) return 'planning';
  return 'working';
}

function activityTypeForRole(role: AgentRole, state: AgentExecutionGraph['nodes'][number]['state']): string {
  if (state === 'waiting_on_human') return 'human_decision';
  if (state === 'waiting_on_agent') return 'dependency_monitoring';
  if (state === 'monitoring' || state === 'completed_for_iteration' || state === 'observing') return 'obligation_monitoring';
  if (state === 'blocked') return 'blocker_resolution';
  const types: Record<AgentRole, string> = {
    manager: 'iteration_coordination',
    requirements: 'requirements_analysis',
    product: 'increment_shaping',
    ux: 'journey_design',
    architecture: 'architecture_design',
    data: 'data_design',
    security: 'threat_modeling',
    planner: 'work_planning',
    builder: 'implementation',
    test: 'browser_verification',
    reviewer: 'evidence_review',
    gate: 'readiness_evaluation',
    deployment: 'preview_deployment',
    validation: 'outcome_validation',
  };
  return types[role];
}

function activitySummaryForNode(
  step: (typeof deliveryAgentGraph)[number],
  state: AgentExecutionGraph['nodes'][number]['state'],
  context: {
    pendingQuestion?: string;
    failedSummary?: string;
    unmetDependencies: AgentRole[];
    eventSummary?: string;
  },
): string {
  if (state === 'waiting_on_human') return `Waiting for a human answer: ${context.pendingQuestion ?? 'a required decision'}`;
  if (state === 'blocked') return context.failedSummary ?? 'Cannot continue until the recorded blocker is resolved.';
  if (state === 'waiting_on_agent') {
    return `Waiting for ${context.unmetDependencies.map(roleDisplayName).join(' and ')} to deliver required evidence.`;
  }
  if (state === 'monitoring') return `Monitoring changes that could affect ${step.artifactName}.`;
  if (state === 'completed_for_iteration') return `${step.artifactName} is complete for this iteration; monitoring the reviewed revision.`;
  if (state === 'ready') return `Ready to begin ${activityTypeForRole(step.role, state).replaceAll('_', ' ')}.`;
  if (context.eventSummary
    && !/^working\.?$/iu.test(context.eventSummary.trim())
    && !/working from (?:its|the) approved dependencies/iu.test(context.eventSummary)) return context.eventSummary;
  const summaries: Record<AgentRole, string> = {
    manager: 'Evaluating the objective, obligations, evidence, risks, and iteration boundary.',
    requirements: 'Comparing the project intent with explicit acceptance criteria and edge cases.',
    product: 'Defining the smallest useful increment and its success signals.',
    ux: 'Mapping the primary journey, visible states, and accessibility expectations.',
    architecture: 'Defining system boundaries, interfaces, and material technical decisions.',
    data: 'Reviewing persistence, migration, retention, and sensitive-data requirements.',
    security: 'Revising the threat model against the current architecture and user journey.',
    planner: 'Ordering bounded work packages, evidence, permissions, and dependencies.',
    builder: 'Implementing the current work package against the approved iteration plan.',
    test: 'Running browser and acceptance verification against the exact preview revision.',
    reviewer: 'Comparing implementation and Test evidence with the requirements baseline.',
    gate: 'Evaluating mandatory evidence, findings, and revision-bound readiness.',
    deployment: 'Preparing or validating a permission-bounded deployment.',
    validation: 'Checking the delivered result against the intended human outcome.',
  };
  return summaries[step.role];
}

function summarizeModelUsage(artifacts: ProjectArtifact[]) {
  const seen = new Set<string>();
  let tokens = 0;
  let cost = 0;
  for (const artifact of artifacts) {
    for (const [index, invocation] of (artifact.modelInvocations ?? []).entries()) {
      const id = invocation.requestId
        ? `${invocation.provider ?? artifact.modelProvider ?? 'unknown'}:${invocation.requestId}`
        : `${artifact.id}:${index}`;
      if (seen.has(id)) continue;
      seen.add(id);
      tokens += invocation.usage?.totalTokens
        ?? (invocation.usage?.promptTokens ?? 0) + (invocation.usage?.completionTokens ?? 0);
      if ((invocation.provider ?? artifact.modelProvider) === 'openrouter') cost += invocation.usage?.cost ?? 0;
    }
  }
  return { tokens, cost };
}

function summarizeRoleModelUsage(
  detail: ProjectDetail,
  iterationId: string | undefined,
  role: AgentRole,
  fallbackArtifacts: ProjectArtifact[],
) {
  if (detail.modelInvocations === undefined) return summarizeModelUsage(fallbackArtifacts);
  const invocations = detail.modelInvocations.filter((invocation) =>
    invocation.iterationId === iterationId && invocation.role === role);
  return {
    tokens: invocations.reduce((total, invocation) => total + invocation.totalTokens, 0),
    cost: invocations.reduce((total, invocation) =>
      total + (invocation.provider === 'openrouter' ? invocation.costUsd : 0), 0),
  };
}

function interactionsBetween(interactions: AgentInteraction[], left: AgentRole, right: AgentRole) {
  return interactions
    .filter((interaction) =>
      (interaction.from === left && interaction.to.includes(right))
      || (interaction.from === right && interaction.to.includes(left)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function isAgentRoleParty(value: AgentInteractionParty): value is AgentRole {
  return deliveryAgentGraph.some((definition) => definition.role === value);
}

function roleDisplayName(role: AgentRole) {
  return deliveryAgentGraph.find((definition) => definition.role === role)?.label ?? role;
}

function buildAgentInteractions(detail: ProjectDetail, completedRoles: Set<AgentRole>): AgentInteraction[] {
  const eventInteractions = detail.organismEvents
    ? detail.organismEvents.flatMap((event) => {
        const interaction = interactionFromOrganismEvent(event, detail);
        return interaction ? [interaction] : [];
      })
    : detail.events.map((event) => {
    const normalized = `${event.title} ${event.description}`.toLowerCase();
    const role = event.agentRole ?? undefined;
    const from = interactionSender(event, normalized);
    const kind = interactionKind(event, normalized);
    const status = interactionStatus(event, normalized, role ? completedRoles.has(role) : false);
    const references = detail.artifacts
      .filter((artifact) => artifact.producedBy === role && normalized.includes(artifact.name.toLowerCase()))
      .map((artifact) => ({
        artifactId: artifact.id,
        artifactType: artifact.type,
        version: String(artifact.version),
        name: artifact.name,
        ownerRole: artifact.producedBy,
        storageUri: artifact.repositoryUrl ?? undefined,
      }));

    return {
      id: `event:${event.id}`,
      messageId: event.id,
      correlationId: eventCorrelationId(event, detail),
      iterationNumber: event.iterationNumber ?? detail.project.currentIteration,
      from,
      to: interactionRecipients(event, from, kind),
      kind,
      name: event.title,
      summary: event.description,
      status,
      createdAt: event.createdAt,
      artifactRefs: references.length > 0 ? references : undefined,
      priority: interactionPriority(normalized),
      live: status === 'in_progress' || status === 'blocked',
    } satisfies AgentInteraction;
      });

  const questionInteractions = (detail.questions ?? []).flatMap((question): AgentInteraction[] => {
    if (detail.organismEvents && question.status !== 'pending') return [];
    const correlationId = `question:${question.decisionKey}`;
    const asked: AgentInteraction = {
      id: `question:${question.id}`,
      messageId: question.id,
      correlationId,
      iterationNumber: detail.iterations.find((iteration) => iteration.id === question.iterationId)?.number ?? detail.project.currentIteration,
      from: question.agentRole,
      to: ['human'],
      kind: 'question',
      name: question.question,
      summary: question.context ?? 'A human decision is required before this obligation can continue.',
      status: question.status === 'pending' ? 'pending' : 'completed',
      createdAt: question.createdAt,
      priority: 'normal',
      requiresAcknowledgement: true,
      live: question.status === 'pending',
    };
    if (detail.organismEvents) return [asked];
    if (!question.answer) return [asked];
    return [asked, {
      id: `answer:${question.answer.id}`,
      messageId: question.answer.id,
      correlationId,
      iterationNumber: asked.iterationNumber,
      from: 'human',
      to: [question.agentRole],
      kind: 'answer',
      name: 'Human answer recorded',
      summary: question.answer.resolution === 'custom'
        ? question.answer.answer
        : question.answer.resolution === 'agent_decides'
          ? 'The responsible agent may decide within its declared authority.'
          : 'The human selected one of the supplied options.',
      status: 'completed',
      createdAt: question.answer.createdAt,
      priority: 'normal',
      deliveredAt: question.answer.createdAt,
    }];
  });

  const commentInteractions = (detail.agentComments ?? []).flatMap((comment): AgentInteraction[] => {
    if (detail.organismEvents) return [];
    const correlationId = `iteration:${detail.iterations.find((iteration) => iteration.id === comment.iterationId)?.number ?? detail.project.currentIteration}:${comment.agentRole}:human-feedback`;
    const hasMailboxReceipt = (detail.agentMessages ?? []).some((message) =>
      message.from === 'human'
      && message.to.includes(comment.agentRole)
      && message.correlationId === correlationId
      && message.summary === comment.body);
    if (hasMailboxReceipt) return [];
    return [{
      id: `comment:${comment.id}`,
      messageId: comment.id,
      correlationId,
      iterationNumber: detail.iterations.find((iteration) => iteration.id === comment.iterationId)?.number ?? detail.project.currentIteration,
      from: comment.authorType === 'human' ? 'human' : comment.authorRole ?? 'system',
      to: [comment.agentRole],
      kind: 'request',
      name: `Feedback sent to ${roleDisplayName(comment.agentRole)}`,
      summary: comment.body,
      status: 'completed',
      createdAt: comment.createdAt,
      priority: 'normal',
      requiresAcknowledgement: false,
      live: false,
    }];
  });

  const artifactById = new Map(detail.artifacts.map((artifact) => [artifact.id, artifact]));
  const feedbackInteractions = (detail.artifactFeedback ?? []).flatMap((feedback): AgentInteraction[] => {
    if (detail.organismEvents) return [];
    const artifact = artifactById.get(feedback.artifactId);
    if (!artifact) return [];
    const correlationId = `artifact:${artifact.id}`;
    const summary = feedback.feedback || 'The artifact was reviewed with no additional written feedback.';
    const hasMailboxReceipt = (detail.agentMessages ?? []).some((message) =>
      message.from === 'human'
      && message.to.includes(artifact.producedBy)
      && message.correlationId === correlationId
      && message.summary === summary);
    if (hasMailboxReceipt) return [];
    return [{
      id: `artifact-feedback:${feedback.id}`,
      messageId: feedback.id,
      correlationId,
      iterationNumber: detail.iterations.find((iteration) => iteration.id === feedback.iterationId)?.number ?? detail.project.currentIteration,
      from: 'human',
      to: [artifact.producedBy],
      kind: feedback.feedback ? 'revision_request' : 'review',
      name: `${artifact.name} feedback`,
      summary,
      status: 'completed',
      createdAt: feedback.createdAt,
      artifactRefs: [{
        artifactId: artifact.id,
        artifactType: artifact.type,
        version: String(artifact.version),
        name: artifact.name,
        ownerRole: artifact.producedBy,
        storageUri: artifact.repositoryUrl ?? undefined,
      }],
      priority: 'normal',
      live: false,
    }];
  });

  const merged = [
    ...(detail.agentMessages ?? []),
    ...eventInteractions,
    ...questionInteractions,
    ...commentInteractions,
    ...feedbackInteractions,
  ];
  return [...new Map(merged.map((interaction) => [interaction.id, interaction])).values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function eventCorrelationId(event: ProjectEvent, detail: ProjectDetail) {
  const iteration = event.iterationNumber ?? detail.project.currentIteration;
  if (event.kind === 'artifact') {
    const artifact = detail.artifacts.find((candidate) =>
      candidate.producedBy === event.agentRole
      && (`${event.title} ${event.description}`).toLowerCase().includes(candidate.name.toLowerCase()));
    if (artifact) return `artifact:${artifact.id}`;
  }
  if (event.kind === 'review') return `iteration:${iteration}:review`;
  if (event.agentRole) return `iteration:${iteration}:${event.agentRole}`;
  return `iteration:${iteration}`;
}

function interactionPriority(normalized: string): AgentInteraction['priority'] {
  if (/critical|security incident|policy violation/iu.test(normalized)) return 'critical';
  if (/high severity|needs attention|blocked|failed|cannot/iu.test(normalized)) return 'high';
  if (/low severity|informational/iu.test(normalized)) return 'low';
  return 'normal';
}

function interactionSender(event: ProjectEvent, normalized: string): AgentInteractionParty {
  if (event.kind === 'system' && /block|fail|needs attention|unavailable/.test(normalized)) return 'system';
  if (event.agentRole) return event.agentRole;
  if (event.kind === 'project' || event.kind === 'review') return 'human';
  if (event.kind === 'deployment') return 'deployment';
  return 'system';
}

function interactionKind(event: ProjectEvent, normalized: string): AgentInteractionKind {
  if (event.kind === 'review') {
    if (/review cutoff|review proposal|human review candidate/.test(normalized)) return 'review_proposal';
    if (/finding|change|defect|issue/.test(normalized)) return 'finding';
    return 'decision';
  }
  if (event.kind === 'artifact') return /test|evidence|report|decision/.test(normalized) ? 'evidence' : 'handoff';
  if (event.kind === 'project') return /approv|reject|decision/.test(normalized) ? 'decision' : 'order';
  if (event.kind === 'system') return /block|fail|cannot|needs attention|unavailable/.test(normalized) ? 'blocker' : 'control';
  if (event.kind === 'deployment') return 'handoff';
  if (/question|asks|needs a human answer/.test(normalized)) return 'question';
  if (/acknowledged|received/.test(normalized)) return 'acknowledgement';
  return /handoff|publish|deliver/.test(normalized) ? 'handoff' : 'status';
}

function interactionStatus(
  event: ProjectEvent,
  normalized: string,
  roleCompleted: boolean,
): AgentInteractionStatus {
  if (/reject|declin/.test(normalized)) return 'rejected';
  if (/block|fail|cannot|needs attention|unavailable/.test(normalized)) return roleCompleted ? 'completed' : 'blocked';
  if (/started|working|running|in progress/.test(normalized)) return roleCompleted ? 'completed' : 'in_progress';
  if (/acknowledged|accepted|received/.test(normalized)) return 'acknowledged';
  if (/pending|queued|waiting/.test(normalized)) return 'pending';
  return event.kind === 'agent' && !/handoff|completed/.test(normalized) ? 'in_progress' : 'completed';
}

function interactionRecipients(
  event: ProjectEvent,
  from: AgentInteractionParty,
  kind: AgentInteractionKind,
): AgentInteractionParty[] {
  if (from === 'system' && event.agentRole) return [event.agentRole];
  if (event.kind === 'project') return ['manager'];
  if (event.kind === 'review') return from === 'human' ? ['manager', 'gate'] : ['human'];
  if (event.kind === 'deployment') return ['validation'];
  if (typeof from === 'string' && from !== 'human' && from !== 'system' && from !== 'project') {
    if (from === 'gate' && (event.kind === 'artifact' || kind === 'handoff')) return ['human'];
    if (kind === 'handoff' || event.kind === 'artifact') {
      const recipients = deliveryAgentGraph
        .filter((candidate) => (candidate as DeliveryAgentDefinition).activation !== 'authorized_release' && candidate.dependsOn.some((dependency) => dependency === from))
        .map((candidate) => candidate.role);
      if (recipients.length > 0) return recipients;
    }
  }
  return ['project'];
}

export function buildMessageThreads(interactions: AgentInteraction[]): MessageThread[] {
  const grouped = new Map<string, AgentInteraction[]>();
  for (const interaction of interactions) {
    const correlationId = interaction.correlationId ?? `message:${interaction.id}`;
    grouped.set(correlationId, [...(grouped.get(correlationId) ?? []), interaction]);
  }
  return [...grouped.entries()].map(([correlationId, messages]) => {
    const ordered = [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const participants = new Set<AgentRole>();
    const artifactIds = new Set<string>();
    const findingIds = new Set<string>();
    for (const message of ordered) {
      if (isAgentRoleParty(message.from)) participants.add(message.from);
      message.to.filter(isAgentRoleParty).forEach((role) => participants.add(role));
      message.artifactRefs?.forEach((artifact) => artifactIds.add(artifact.artifactId));
      if (message.kind === 'finding' || message.kind === 'blocker') findingIds.add(message.id);
    }
    const blocked = ordered.some((message) => message.status === 'blocked' && message.live !== false);
    const waiting = ordered.some((message) => ['pending', 'acknowledged', 'in_progress'].includes(message.status) && message.live !== false);
    const latest = ordered.at(-1)!;
    return {
      id: `thread:${correlationId}`,
      correlationId,
      title: threadTitle(correlationId, ordered),
      participantRoles: [...participants],
      messageIds: ordered.map((message) => message.id),
      artifactIds: [...artifactIds],
      findingIds: [...findingIds],
      status: blocked ? 'blocked' : waiting ? 'waiting' : ordered.some((message) => message.live) ? 'active' : 'resolved',
      updatedAt: latest.createdAt,
    } satisfies MessageThread;
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function threadTitle(correlationId: string, interactions: AgentInteraction[]) {
  const question = interactions.find((interaction) => interaction.kind === 'question');
  if (question) return question.name;
  const artifact = interactions.flatMap((interaction) => interaction.artifactRefs ?? [])[0];
  if (artifact?.name) return artifact.name;
  const proposal = interactions.find((interaction) => interaction.kind === 'review_proposal');
  if (proposal) return 'Iteration review proposal';
  const first = interactions[0];
  if (correlationId.endsWith(':review')) return `Iteration ${first?.iterationNumber ?? ''} review`.trim();
  if (first && isAgentRoleParty(first.from)) return `${roleDisplayName(first.from)} · ${first.name}`;
  return first?.name ?? correlationId.replaceAll(':', ' · ');
}

export function buildIterationReadiness(
  detail: ProjectDetail,
  nodes: AgentExecutionGraph['nodes'],
  interactions: AgentInteraction[],
): IterationReadiness {
  const iteration = detail.iterations.find((candidate) => candidate.number === detail.project.currentIteration);
  const artifacts = detail.artifacts.filter((artifact) => artifact.iterationId === iteration?.id);
  const requiredRoles = deliveryAgentGraph.filter((definition) =>
    !('activation' in definition) || definition.activation !== 'authorized_release');
  const preview = detail.media
    .filter((media) => media.iterationId === iteration?.id && media.kind === 'preview')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const includedRevision = preview?.sourceRevision ?? null;
  const previewReady = Boolean(includedRevision)
    && (!preview?.expiresAt || Date.parse(preview.expiresAt) > Date.now());
  const evidenceArtifacts = artifacts.filter((artifact) =>
    isCurrentReadinessArtifact(detail, artifact, iteration?.id, includedRevision));
  const readyArtifactCount = requiredRoles.filter((definition) =>
    evidenceArtifacts.some((artifact) =>
      artifact.producedBy === definition.role && artifact.type === definition.artifactType)).length;
  const manualEvidence = detail.media.some((media) =>
    media.iterationId === iteration?.id
    && media.kind === 'user_flow_video'
    && Boolean(includedRevision)
    && media.sourceRevision === includedRevision
    && (!media.expiresAt || Date.parse(media.expiresAt) > Date.now()));
  const gateNode = nodes.find((node) => node.role === 'gate');
  const testArtifact = evidenceArtifacts.some((artifact) => artifact.producedBy === 'test' && artifact.type === 'test-evidence');
  const builderArtifact = evidenceArtifacts.some((artifact) => artifact.producedBy === 'builder' && artifact.type === 'build-submission');
  const pendingHumanDecisions = (detail.questions ?? []).filter((question) =>
    question.status === 'pending' && (question.iterationId === iteration?.id || question.iterationId === null)).length;
  const currentFindings = detail.findings?.filter((finding) =>
    finding.iterationId === iteration?.id
    && ['open', 'acknowledged', 'remediating'].includes(finding.status));
  const openCriticalFindings = currentFindings === undefined
    ? interactions.filter((interaction) =>
      interaction.iterationNumber === detail.project.currentIteration
      && (interaction.kind === 'finding' || interaction.kind === 'blocker')
      && interaction.priority === 'critical'
      && interaction.status !== 'completed').length
    : currentFindings.filter((finding) => finding.severity === 'critical').length;
  const openHighFindings = currentFindings === undefined
    ? interactions.filter((interaction) =>
      interaction.iterationNumber === detail.project.currentIteration
      && (interaction.kind === 'finding' || interaction.kind === 'blocker')
      && interaction.priority === 'high'
      && interaction.status !== 'completed').length
    : currentFindings.filter((finding) => finding.severity === 'high').length;
  const activeRequiredMutation = detail.repositoryOperations === undefined
    ? nodes.some((node) =>
      ['builder', 'deployment'].includes(node.role) && ['planning', 'working', 'communicating'].includes(node.state))
    : detail.repositoryOperations.some((operation) =>
      operation.iterationId === iteration?.id
      && operation.mutating
      && (operation.status === 'queued' || operation.status === 'running'));
  const reviewProposal = currentRevisionReviewProposal(detail, iteration?.id, includedRevision);
  const gateStatus: IterationReadiness['gateStatus'] = reviewProposal?.gateStatus === 'pass'
    ? 'pass'
    : reviewProposal?.gateStatus === 'blocked' || gateNode?.state === 'blocked'
      ? 'blocked'
      : gateNode?.state === 'reviewing' ? 'evaluating' : 'waiting';
  const objectiveStatus: IterationReadiness['objectiveStatus'] = reviewProposal?.gateStatus === 'pass'
    ? reviewProposal.objectiveStatus
    : builderArtifact ? 'partially_satisfied' : 'unsatisfied';
  const canReview = gateStatus === 'pass'
    && reviewProposal?.recommendation === 'send_for_human_review'
    && previewReady
    && readyArtifactCount === requiredRoles.length
    && openCriticalFindings === 0
    && openHighFindings === 0
    && !activeRequiredMutation;
  const managerRecommendation: IterationReadiness['managerRecommendation'] = pendingHumanDecisions > 0
    ? 'request_human_decision'
    : reviewProposal?.recommendation === 'send_for_human_review'
    ? canReview ? 'send_for_human_review'
      : 'continue_iteration'
    : reviewProposal
      ? reviewProposal.recommendation
      : canReview ? 'send_for_human_review'
      : 'continue_iteration';
  const managerRationale = pendingHumanDecisions > 0
    ? `${pendingHumanDecisions} human decision${pendingHumanDecisions === 1 ? ' is' : 's are'} still required before the iteration boundary is safe.`
    : reviewProposal
    ? reviewProposal.managerRationale
    : canReview
    ? `Gate passed for ${preview?.sourceRevision ? `revision ${preview.sourceRevision.slice(0, 12)}` : 'the current preview'}; required evidence is present and no required mutation remains active.`
    : gateStatus === 'blocked'
        ? 'Gate is blocked by mandatory evidence or an unresolved finding; Manager cannot propose review.'
        : !previewReady
          ? 'The reviewable implementation does not yet have a revision-bound runnable preview.'
          : `${readyArtifactCount} of ${requiredRoles.length} required role artifacts are available; continue the iteration.`;

  return {
    objectiveStatus,
    includedRevision,
    items: [
      {
        id: 'iteration-objective',
        label: 'Iteration objective',
        status: objectiveStatus === 'satisfied' || objectiveStatus === 'satisfied_with_known_gaps' ? 'ready' : builderArtifact ? 'waiting' : 'blocked',
        summary: builderArtifact ? 'A reviewable implementation exists for the current objective.' : 'Builder has not produced a reviewable implementation yet.',
      },
      {
        id: 'runnable-preview',
        label: 'Runnable preview',
        status: previewReady ? 'ready' : 'waiting',
        summary: previewReady ? `A current-iteration preview is bound to revision ${includedRevision!.slice(0, 12)}.` : 'No unexpired, revision-bound current-iteration preview is recorded.',
      },
      {
        id: 'required-artifacts',
        label: 'Required artifacts',
        status: readyArtifactCount === requiredRoles.length ? 'ready' : 'waiting',
        summary: `${readyArtifactCount} of ${requiredRoles.length} required role artifacts are available.`,
        current: readyArtifactCount,
        target: requiredRoles.length,
      },
      {
        id: 'automated-tests',
        label: 'Automated tests',
        status: testArtifact ? 'ready' : 'waiting',
        summary: testArtifact ? 'Test evidence is recorded for this iteration.' : 'Test evidence is not yet recorded.',
      },
      {
        id: 'manual-evidence',
        label: 'Manual evidence',
        status: manualEvidence ? 'ready' : 'waiting',
        summary: manualEvidence ? 'A recorded user journey is available.' : 'Recorded browser-journey evidence is not yet available.',
      },
      {
        id: 'open-findings',
        label: 'Open findings',
        status: openCriticalFindings > 0 || openHighFindings > 0 ? 'blocked' : 'ready',
        summary: `${openCriticalFindings} critical · ${openHighFindings} high open findings.`,
        current: openCriticalFindings + openHighFindings,
        target: 0,
      },
      {
        id: 'human-decisions',
        label: 'Human decisions',
        status: pendingHumanDecisions > 0 ? 'waiting' : 'ready',
        summary: `${pendingHumanDecisions} decision${pendingHumanDecisions === 1 ? '' : 's'} pending.`,
        current: pendingHumanDecisions,
        target: 0,
      },
      {
        id: 'gate-status',
        label: 'Gate status',
        status: gateStatus === 'pass' ? 'ready' : gateStatus === 'blocked' ? 'blocked' : 'waiting',
        summary: gateStatus === 'pass'
          ? `A non-rejected Gate-backed proposal is recorded for revision ${includedRevision!.slice(0, 12)}.`
          : gateStatus === 'blocked' ? 'Mandatory readiness is blocked.' : 'No current-revision Gate pass is recorded.',
      },
    ],
    openCriticalFindings,
    openHighFindings,
    pendingHumanDecisions,
    gateStatus,
    managerRecommendation,
    managerRationale,
    proposedAt: reviewProposal?.recommendation === 'send_for_human_review' ? reviewProposal.createdAt : null,
  };
}

function isCurrentReadinessArtifact(
  detail: ProjectDetail,
  artifact: ProjectArtifact,
  iterationId: string | undefined,
  includedRevision: string | null,
): boolean {
  if (artifact.iterationId !== iterationId || !['ready_for_review', 'approved'].includes(artifact.status)) return false;
  if (detail.artifactVersions === undefined) return true;
  const canonicalVersions = detail.artifactVersions.filter((version) =>
    version.artifactId === artifact.id && version.version === artifact.version);
  if (canonicalVersions.length === 0) return false;
  const requiresExactRevision = artifact.type === 'test-evidence'
    || artifact.type === 'review-decision'
    || artifact.type === 'gate-decision';
  return canonicalVersions.some((version) =>
    ['ready_for_review', 'approved'].includes(version.status)
    && (requiresExactRevision
      ? Boolean(includedRevision) && version.sourceRevision === includedRevision
      : !version.sourceRevision || !includedRevision || version.sourceRevision === includedRevision));
}

function currentRevisionReviewProposal(
  detail: ProjectDetail,
  iterationId: string | undefined,
  includedRevision: string | null,
): IterationReviewProposal | undefined {
  if (!iterationId || !includedRevision) return undefined;
  const iteration = detail.iterations.find((candidate) => candidate.id === iterationId);
  if (iteration?.status === 'changes_requested' || iteration?.status === 'blocked') return undefined;
  const evidenceTimestamps = [
    ...detail.artifacts.filter((artifact) => artifact.iterationId === iterationId).map((artifact) => artifact.createdAt),
    ...detail.media.filter((media) => media.iterationId === iterationId).map((media) => media.createdAt),
    ...(detail.artifactVersions ?? []).filter((version) => version.iterationId === iterationId).map((version) => version.createdAt),
    ...(detail.findings ?? []).filter((finding) => finding.iterationId === iterationId).map((finding) => finding.updatedAt),
    ...(detail.agentGoals ?? []).filter((goal) => goal.iterationId === iterationId).map((goal) => goal.updatedAt),
    ...(detail.agentActionPlans ?? []).filter((plan) => plan.iterationId === iterationId).map((plan) => plan.updatedAt),
    ...(detail.agentActions ?? []).filter((action) => action.iterationId === iterationId).map((action) => action.updatedAt),
    ...(detail.agentObligations ?? []).filter((obligation) => obligation.iterationId === iterationId).map((obligation) => obligation.updatedAt),
    ...(detail.modelInvocations ?? []).filter((invocation) => invocation.iterationId === iterationId).map((invocation) => invocation.completedAt ?? invocation.createdAt),
    ...(detail.repositoryOperations ?? []).filter((operation) => operation.iterationId === iterationId).map((operation) => operation.completedAt ?? operation.createdAt),
    ...(detail.questions ?? []).filter((question) => question.iterationId === iterationId || question.iterationId === null).map((question) => question.updatedAt),
    ...(detail.agentComments ?? []).filter((comment) => comment.iterationId === iterationId || comment.iterationId === null).map((comment) => comment.createdAt),
    ...(detail.artifactFeedback ?? []).map((feedback) => feedback.createdAt),
    ...(detail.iterationReviews ?? []).filter((review) => review.iterationId === iterationId).map((review) => review.createdAt),
  ].map((timestamp) => Date.parse(timestamp)).filter(Number.isFinite);
  const latestEvidenceAt = evidenceTimestamps.length > 0 ? Math.max(...evidenceTimestamps) : 0;
  return (detail.iterationReviewProposals ?? [])
    .filter((proposal) =>
      proposal.iterationId === iterationId
      && proposal.includedRevision === includedRevision
      && proposal.status !== 'rejected'
      && proposal.status !== 'superseded'
      && Date.parse(proposal.createdAt) >= latestEvidenceAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export async function getIteration(projectId: string, number: number): Promise<ProjectIteration> {
  return (await store()).iteration(projectId, number);
}

export async function setProjectStatus(projectId: string, status: ProjectStatus): Promise<void> {
  await (await store()).updateStatus(projectId, status);
}

export async function setIterationStatus(
  projectId: string,
  iterationNumber: number,
  status: ProjectIteration['status'],
): Promise<void> {
  const updated = await (await store()).updateIterationStatus(projectId, iterationNumber, status);
  if (!updated) throw new Error(`Iteration ${iterationNumber} was not found for project ${projectId}.`);
}

export async function connectProjectRepository(project: Project): Promise<Project> {
  const repository = await ensureProjectRepository(project);
  const database = await store();
  const connected = await database.connectRepository(project.id, repository);
  const labels = await ensureProjectLifecycleLabels(connected);
  await database.recordRepositoryLifecycle({
    projectId: project.id,
    kind: 'repository_connected',
    status: 'completed',
    repositoryUrl: repository.url,
    externalId: `${repository.owner}/${repository.name}`,
    summary: 'The shared Forgejo repository is connected to the project organism.',
    metadata: { owner: repository.owner, name: repository.name, labels },
  });
  await database.addEvent({
    projectId: project.id, iterationNumber: null, kind: 'project',
    title: 'Forgejo repository connected', description: `Agents will collaborate in ${repository.owner}/${repository.name}.`, agentRole: 'manager',
  });
  return connected;
}

export async function prepareIterationRepository(project: Project, iteration: ProjectIteration): Promise<ProjectIteration> {
  const issueWasNew = !iteration.issueNumber;
  const branchWasNew = !iteration.branchName;
  const issue = await createIterationIssue(project, iteration);
  const branchName = iteration.branchName ?? `iteration-${iteration.number}-agents`;
  const database = await store();
  const prepared = await database.updateIterationDelivery(iteration.id, { issueNumber: issue.number, branchName });
  await labelIterationStatus(project, prepared, 'in-progress');
  if (issueWasNew) {
    await database.recordRepositoryLifecycle({
      projectId: project.id,
      iterationId: iteration.id,
      kind: 'issue_created',
      status: 'completed',
      repositoryUrl: project.repositoryUrl,
      externalId: String(issue.number),
      summary: `Iteration issue #${issue.number} was created.`,
      metadata: { iterationNumber: iteration.number },
    });
  }
  if (branchWasNew) {
    await database.recordRepositoryLifecycle({
      projectId: project.id,
      iterationId: iteration.id,
      kind: 'branch_created',
      status: 'completed',
      repositoryUrl: project.repositoryUrl,
      externalId: branchName,
      summary: `Iteration branch ${branchName} is the shared agent workspace.`,
      metadata: { baseBranch: 'main' },
    });
  }
  const detail = await database.detail(project.id);
  for (const artifact of selectRepositoryPreparationArtifacts(detail, iteration.id)) {
    const location = await commitArtifact(project, prepared, artifact);
    const located = await (await store()).locateArtifact(artifact.id, location.path, location.url);
    await addIterationComment(project, prepared, agentCommitSummary(artifact.producedBy, located));
  }
  return prepared;
}

export function selectRepositoryPreparationArtifacts(
  detail: ProjectDetail | undefined,
  iterationId: string,
): ProjectArtifact[] {
  if (!detail) return [];
  const storageByArtifact = new Map((detail.artifactVersions ?? []).map((version) => [
    version.artifactId,
    version.metadata.storage,
  ]));
  return detail.artifacts.filter((artifact) =>
    artifact.iterationId === iterationId
      && (artifact.status === 'ready_for_review' || artifact.status === 'approved')
      && artifact.storageMode !== 'ledger'
      && storageByArtifact.get(artifact.id) !== 'ledger'
      && !artifact.repositoryUrl);
}

export async function recordAgentStarted(
  project: Project,
  iteration: ProjectIteration,
  role: AgentRole,
  inputArtifacts?: AgentArtifactReference[],
  supervisedBy?: AgentRole[],
): Promise<void> {
  const handoff = inputArtifacts?.length ? ` It received ${inputArtifacts.map((artifact) => artifact.name).join(', ')}.` : '';
  const supervision = supervisedBy?.length ? ` Supervised by ${supervisedBy.join(' and ')}.` : '';
  const definition = deliveryAgentGraph.find((candidate) => candidate.role === role)!;
  const activity = activitySummaryForNode(definition, activeStateForRole(role), {
    unmetDependencies: [],
  });
  await (await store()).addEvent({
    projectId: project.id,
    iterationNumber: iteration.number,
    kind: 'agent',
    title: `${role[0].toUpperCase()}${role.slice(1)} agent started`,
    description: `${activity}${handoff}${supervision}`,
    agentRole: role,
  });
  const received = inputArtifacts?.length ? ` Received: ${inputArtifacts.map((artifact) => `[${artifact.name}](${artifact.repositoryUrl ?? project.repositoryUrl})`).join(', ')}.` : '';
  await addIterationComment(project, iteration, `🟠 **${role} agent started** using its dedicated Temporal workflow.${received}${supervision}`);
}

export interface RecordedAgentArtifacts {
  artifacts: AgentArtifactReference[];
  questionIds: string[];
  /** Exact root snapshot that owns this idempotent operation. */
  draft?: AgentArtifactDraft;
}

export function agentArtifactChildOperationKey(
  operationKey: string,
  kind: 'artifact' | 'question',
  index: number,
): string {
  return `${operationKey}:${kind}:${index}`;
}

function canonicalArtifactOperationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalArtifactOperationValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, canonicalArtifactOperationValue(child)]));
}

export function agentArtifactOperationManifestHash(
  draft: AgentArtifactDraft,
  envelope?: ArtifactOperationRecoveryEnvelope,
): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalArtifactOperationValue(envelope ? { draft, envelope } : draft)))
    .digest('hex')}`;
}

export async function recordAgentArtifact(
  project: Project,
  iteration: ProjectIteration,
  draft: AgentArtifactDraft,
  operationKey?: string,
  persistence?: {
    storage: 'repository' | 'ledger';
    sourceRevision?: string;
    bindRecoveryEnvelope?: boolean;
  },
): Promise<RecordedAgentArtifacts> {
  const database = await store();
  const operationDraft = draft;
  const recoveryEnvelope: ArtifactOperationRecoveryEnvelope = {
    iterationId: iteration.id,
    type: operationDraft.type,
    producedBy: operationDraft.producedBy,
    storage: persistence?.storage ?? 'repository',
    sourceRevision: persistence?.sourceRevision ?? null,
  };
  const operationManifestHash = operationKey
    ? agentArtifactOperationManifestHash(
      operationDraft,
      persistence?.bindRecoveryEnvelope ? recoveryEnvelope : undefined,
    )
    : undefined;
  const drafts: AgentArtifactDraft[] = [operationDraft, ...(operationDraft.attachments ?? []).map((attachment) => ({
    ...attachment,
    producedBy: operationDraft.producedBy,
    model: operationDraft.model,
    modelProvider: operationDraft.modelProvider,
    modelInvocations: operationDraft.modelInvocations,
  }))];
  const saved: ProjectArtifact[] = [];
  const stageForRepository = persistence?.storage !== 'ledger';
  for (const [index, item] of drafts.entries()) {
    const childOperationKey = operationKey
      ? agentArtifactChildOperationKey(operationKey, 'artifact', index)
      : undefined;
    const artifact = await database.addArtifact(
      project.id,
      iteration.id,
      item,
      iteration.number,
      childOperationKey,
      {
        operationManifestHash,
        modelInvocationOperationPrefix: operationKey,
        modelInvocationExecutionId: operationDraft.executionTrace?.executionId,
        ...(index === 0 ? { operationPayload: operationDraft } : {}),
        stageForRepository,
        storage: persistence?.storage ?? 'repository',
        sourceRevision: persistence?.sourceRevision,
      },
    );
    if (!stageForRepository) {
      saved.push(artifact);
      continue;
    }
    let recorded = artifact;
    if (artifact.repositoryPath && artifact.repositoryUrl) {
      if (!iteration.branchName) iteration.branchName = `iteration-${iteration.number}-agents`;
    } else {
      const location = await commitArtifact(project, iteration, artifact);
      recorded = await database.locateArtifact(artifact.id, location.path, location.url, {
        executionTrace: item.executionTrace,
        iterationNumber: iteration.number,
        eventOperationKey: childOperationKey ? `${childOperationKey}:event` : undefined,
      });
      if (!iteration.branchName) iteration.branchName = location.branch;
    }
    saved.push(recorded);
    const comment = agentCommitSummary(operationDraft.producedBy, recorded);
    if (childOperationKey) {
      await addIterationCommentOnce(project, iteration, comment, `${childOperationKey}:comment`);
    } else {
      await addIterationComment(project, iteration, comment);
    }
  }
  const questionIds: string[] = [];
  for (const [index, question] of (operationDraft.questions ?? []).entries()) {
    const persisted = await database.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: operationDraft.producedBy,
      ...question,
    }, operationKey ? agentArtifactChildOperationKey(operationKey, 'question', index) : undefined);
    questionIds.push(persisted.id);
  }
  await labelIterationAgent(project, iteration, operationDraft.producedBy);
  return { artifacts: saved.map(toAgentArtifactReference), questionIds, draft: operationDraft };
}

export async function loadAgentArtifactOperationDraft(
  projectId: string,
  operationKey: string,
  expectedEnvelope?: ArtifactOperationRecoveryEnvelope,
): Promise<AgentArtifactDraft | undefined> {
  return (await store()).loadArtifactOperationDraft(
    projectId,
    agentArtifactChildOperationKey(operationKey, 'artifact', 0),
    expectedEnvelope,
  );
}

export async function rejectAgentArtifacts(
  projectId: string,
  artifactIds: string[],
): Promise<void> {
  await (await store()).rejectArtifacts(projectId, artifactIds);
}

export async function recordDynamicAgentQuestion(
  project: Project,
  iteration: ProjectIteration,
  role: AgentRole,
  decision: DynamicHumanDecisionRequest,
  operationKey: string,
): Promise<AgentQuestion> {
  const persisted = await (await store()).addAgentQuestion({
    projectId: project.id,
    iterationId: iteration.id,
    agentRole: role,
    decisionKey: decision.decisionKey,
    question: decision.question,
    context: decision.context,
    options: decision.options,
    allowCustomAnswer: decision.allowCustomAnswer,
    allowAgentDecide: decision.allowAgentDecide,
  }, operationKey);
  await (await store()).addEvent({
    projectId: project.id,
    iterationNumber: iteration.number,
    kind: 'agent',
    title: `${role[0].toUpperCase()}${role.slice(1)} agent is waiting for a decision`,
    description: decision.question,
    agentRole: role,
  }, `${operationKey}:event`);
  return persisted;
}

export async function areAgentQuestionsAnswered(projectId: string, questionIds: readonly string[]): Promise<boolean> {
  for (const questionId of questionIds) {
    const question = await (await store()).findAgentQuestion(questionId);
    if (!question || question.projectId !== projectId || question.status !== 'answered') return false;
  }
  return true;
}

export async function reconcileAgentQuestionDecisions(projectId: string): Promise<number> {
  const database = await store();
  const reused = await database.reconcileAgentQuestionDecisions(projectId);
  if (reused > 0) {
    await database.addEvent({
      projectId,
      iterationNumber: null,
      kind: 'project',
      title: 'Human decisions reused across agents',
      description: `${reused} equivalent agent question${reused === 1 ? '' : 's'} inherited an existing human answer.`,
      agentRole: null,
    });
  }
  return reused;
}

export async function persistAgentQuestionAnswer(
  projectId: string,
  questionId: string,
  answer: AgentQuestionAnswerInput,
): Promise<AgentQuestion> {
  const database = await store();
  const existing = await database.findAgentQuestion(questionId);
  if (!existing || existing.projectId !== projectId) throw new Error('Agent question was not found for this project.');
  const answered = await database.answerProjectAgentQuestion(projectId, questionId, answer, 'human');
  if (!answered) throw new Error('Agent question could not be answered.');
  await database.addEvent({
    projectId,
    iterationNumber: null,
    kind: 'project',
    title: `Human answered the ${existing.agentRole} agent`,
    description: describeQuestionAnswer(answer, answered),
    agentRole: existing.agentRole,
  });
  return answered;
}

function describeQuestionAnswer(answer: AgentQuestionAnswerInput, question: AgentQuestion): string {
  if (answer.resolution === 'custom') return answer.answer;
  if (answer.resolution === 'agent_decides') return 'The human explicitly authorized the agent to decide within its existing scope.';
  const selected = question.options.find((option) => option.id === answer.optionId);
  return selected ? `${selected.label}: ${selected.description ?? selected.value}` : `Selected option ${answer.optionId}.`;
}

export async function persistAgentComment(
  comment: AgentCommentInput,
  deliveryMode: AgentMessageDeliveryMode = 'static_history',
): Promise<AgentMessage | undefined> {
  const database = await store();
  const persisted = await database.addAgentComment(comment);
  const detail = await database.detail(comment.projectId);
  const iterationNumber = detail?.iterations.find((iteration) => iteration.id === comment.iterationId)?.number
    ?? detail?.project.currentIteration
    ?? 1;
  await database.addEvent({
    projectId: comment.projectId,
    iterationNumber: null,
    kind: 'project',
    title: `Human direction for the ${comment.agentRole} agent`,
    description: comment.body,
    agentRole: comment.agentRole,
  });
  if (deliveryMode !== 'actor_mailbox') return undefined;
  const message = buildHumanGuidanceMessage({
    projectId: comment.projectId,
    iterationId: comment.iterationId ?? undefined,
    iterationNumber,
    recipientRole: comment.agentRole,
    sourceRecordId: persisted.id,
    sourceKind: 'agent_comment',
    summary: comment.body,
    createdAt: persisted.createdAt,
  });
  await database.recordAgentMessage(message);
  return message;
}

export async function persistArtifactFeedback(
  projectId: string,
  feedback: ArtifactFeedbackInput,
  deliveryMode: AgentMessageDeliveryMode = 'static_history',
): Promise<AgentRole | { role: AgentRole; message: AgentMessage }> {
  const database = await store();
  const detail = await database.detail(projectId);
  const artifact = detail?.artifacts.find((candidate) => candidate.id === feedback.artifactId);
  if (!artifact) throw new Error('Artifact was not found for this project.');
  const persisted = await database.addProjectArtifactFeedback(projectId, feedback);
  await database.addEvent({
    projectId,
    iterationNumber: null,
    kind: 'review',
    title: `Human feedback on ${artifact.name}`,
    description: feedback.feedback || 'The artifact was reviewed with no additional written feedback.',
    agentRole: artifact.producedBy,
  });
  if (deliveryMode !== 'actor_mailbox') return artifact.producedBy;
  const iterationNumber = detail?.iterations.find((iteration) => iteration.id === artifact.iterationId)?.number
    ?? detail?.project.currentIteration
    ?? 1;
  const message = buildHumanGuidanceMessage({
    projectId,
    iterationId: artifact.iterationId,
    iterationNumber,
    recipientRole: artifact.producedBy,
    sourceRecordId: persisted.id,
    sourceKind: 'artifact_feedback',
    summary: feedback.feedback || 'The human reviewed this artifact with no additional written feedback.',
    createdAt: persisted.createdAt,
    artifact,
  });
  await database.recordAgentMessage(message);
  return { role: artifact.producedBy, message };
}

export type AgentMessageDeliveryMode = 'static_history' | 'actor_mailbox';

export function buildHumanGuidanceMessage(input: {
  projectId: string;
  iterationId?: string;
  iterationNumber: number;
  recipientRole: AgentRole;
  sourceRecordId: string;
  sourceKind: 'agent_comment' | 'artifact_feedback';
  summary: string;
  createdAt: string;
  artifact?: ProjectArtifact;
}): AgentMessage {
  const idempotencyKey = `${input.projectId}:human-guidance:${input.sourceKind}:${input.sourceRecordId}:mailbox-v1`;
  return {
    schemaVersion: '1.0',
    messageId: idempotencyKey,
    idempotencyKey,
    projectId: input.projectId,
    ...(input.iterationId ? { iterationId: input.iterationId } : {}),
    correlationId: input.sourceKind === 'artifact_feedback' && input.artifact
      ? `artifact:${input.artifact.id}`
      : `iteration:${input.iterationNumber}:${input.recipientRole}:human-feedback`,
    sender: {
      projectId: input.projectId,
      role: 'manager',
      workflowId: `project/${input.projectId}/agent/manager`,
    },
    recipients: [{
      projectId: input.projectId,
      role: input.recipientRole,
      workflowId: `project/${input.projectId}/agent/${input.recipientRole}`,
    }],
    kind: 'CONTROL',
    name: input.sourceKind === 'artifact_feedback' ? 'human.artifact_feedback' : 'human.agent_guidance',
    priority: 'NORMAL',
    graphVersion: 1,
    projectStateVersion: input.iterationNumber,
    senderStateVersion: input.iterationNumber,
    authority: {
      grantId: `human-guidance:${input.sourceRecordId}`,
      issuerRole: 'human',
      level: 'ITERATION',
      permittedActions: ['PROVIDE_GUIDANCE'],
      permittedTargets: [input.recipientRole],
      scopeRefs: [input.sourceRecordId],
      mayDelegate: false,
    },
    payload: {
      summary: input.summary,
      iterationNumber: input.iterationNumber,
      authoredBy: 'human',
      sourceKind: input.sourceKind,
      sourceRecordId: input.sourceRecordId,
    },
    ...(input.artifact ? { artifactRefs: [{
      artifactId: input.artifact.id,
      artifactType: input.artifact.type,
      version: String(input.artifact.version),
      name: input.artifact.name,
      ownerRole: input.artifact.producedBy,
      storageUri: input.artifact.repositoryUrl ?? undefined,
    }] } : {}),
    acknowledgementRequired: true,
    createdAt: input.createdAt,
  };
}

export function buildAgentHandoffMessage(
  project: Project,
  iteration: ProjectIteration,
  role: AgentRole,
  artifacts: AgentArtifactReference[],
  handsOffTo: AgentRole[],
  deliveryMode: AgentMessageDeliveryMode,
  createdAt: string,
): AgentMessage {
  const artifactNames = artifacts.map((artifact) => artifact.name).join(', ') || 'The bounded role output';
  const recipientRoles = [...new Set(handsOffTo.length > 0 ? handsOffTo : ['manager' as const])];
  const recipients = recipientRoles.join(', ');
  const artifactVersions = artifacts.map((artifact) => `${artifact.id}@${artifact.version}`).join(',') || 'no-artifacts';
  const handoffDigest = createHash('sha256').update(artifactVersions).digest('hex').slice(0, 16);
  const deliverySuffix = deliveryMode === 'actor_mailbox' ? ':mailbox-v1' : '';
  const idempotencyKey = `${project.id}:i${iteration.number}:${role}:handoff:${handoffDigest}${deliverySuffix}`;
  return {
    schemaVersion: '1.0',
    messageId: idempotencyKey,
    idempotencyKey,
    projectId: project.id,
    iterationId: iteration.id,
    correlationId: `iteration:${iteration.number}:${role}`,
    sender: {
      projectId: project.id,
      role,
      workflowId: `project/${project.id}/agent/${role}`,
    },
    recipients: recipientRoles.map((recipient) => ({
      projectId: project.id,
      role: recipient,
      workflowId: `project/${project.id}/agent/${recipient}`,
    })),
    kind: 'EVIDENCE',
    name: 'artifact.handoff',
    priority: 'NORMAL',
    graphVersion: 1,
    projectStateVersion: iteration.number,
    senderStateVersion: iteration.number,
    authority: {
      grantId: `iteration:${iteration.id}:${role}:handoff`,
      issuerRole: role,
      level: 'ITERATION',
      permittedActions: ['HANDOFF'],
      permittedTargets: recipientRoles,
      scopeRefs: artifacts.map((artifact) => artifact.id),
      mayDelegate: false,
    },
    payload: {
      summary: `${artifactNames} ${artifacts.length === 1 ? 'was' : 'were'} handed to ${recipients}.`,
      iterationNumber: iteration.number,
    },
    artifactRefs: artifacts.map((artifact) => ({
      artifactId: artifact.id,
      artifactType: artifact.type,
      version: String(artifact.version),
      name: artifact.name,
      ownerRole: artifact.producedBy,
      storageUri: artifact.repositoryUrl ?? undefined,
    })),
    acknowledgementRequired: deliveryMode === 'actor_mailbox',
    createdAt,
  };
}

export function buildAgentFailureMessage(
  projectId: string,
  iterationNumber: number,
  role: AgentRole,
  summary: string,
  deliveryMode: AgentMessageDeliveryMode,
  createdAt: string,
): AgentMessage {
  const digest = createHash('sha256').update(summary).digest('hex').slice(0, 16);
  const deliverySuffix = deliveryMode === 'actor_mailbox' ? ':mailbox-v1' : '';
  const idempotencyKey = `${projectId}:i${iterationNumber}:${role}:blocker:${digest}${deliverySuffix}`;
  const recipientRoles = ['manager', 'gate'] as const satisfies readonly AgentRole[];
  return {
    schemaVersion: '1.0',
    messageId: idempotencyKey,
    idempotencyKey,
    projectId,
    correlationId: `iteration:${iterationNumber}:${role}`,
    sender: { projectId, role, workflowId: `project/${projectId}/agent/${role}` },
    recipients: recipientRoles.map((recipient) => ({
      projectId,
      role: recipient,
      workflowId: `project/${projectId}/agent/${recipient}`,
    })),
    kind: 'ESCALATION',
    name: 'agent.blocked',
    priority: 'HIGH',
    graphVersion: 1,
    projectStateVersion: iterationNumber,
    senderStateVersion: iterationNumber,
    authority: {
      grantId: `iteration:${iterationNumber}:${role}:escalation`,
      issuerRole: role,
      level: 'ITERATION',
      permittedActions: ['ESCALATE_BLOCKER'],
      permittedTargets: [...recipientRoles],
      scopeRefs: [`iteration:${iterationNumber}`],
      mayDelegate: false,
    },
    payload: { summary, iterationNumber },
    acknowledgementRequired: deliveryMode === 'actor_mailbox',
    createdAt,
  };
}

export async function recordAgentHandoff(
  project: Project,
  iteration: ProjectIteration,
  role: AgentRole,
  artifacts: AgentArtifactReference[],
  handsOffTo: AgentRole[],
  deliveryMode: AgentMessageDeliveryMode = 'static_history',
): Promise<AgentMessage | undefined> {
  const artifactNames = artifacts.map((artifact) => artifact.name).join(', ') || 'The bounded role output';
  const protocolMessage = buildAgentHandoffMessage(
    project,
    iteration,
    role,
    artifacts,
    handsOffTo,
    deliveryMode,
    new Date().toISOString(),
  );
  const recipients = protocolMessage.recipients.map((recipient) => recipient.role).join(', ');
  const assuranceLedgerOnly = role === 'test' || role === 'reviewer' || role === 'gate';
  const provenance = assuranceLedgerOnly
    ? 'was recorded as immutable candidate-revision evidence in the project ledger'
    : 'was committed to the shared candidate branch';
  const database = await store();
  await database.addEvent({
    projectId: project.id,
    iterationNumber: iteration.number,
    kind: 'agent',
    title: `${role[0].toUpperCase()}${role.slice(1)} handoff completed`,
    description: `${artifactNames} ${artifacts.length === 1 ? provenance : provenance.replace('was ', 'were ')} and handed to ${recipients}.`,
    agentRole: role,
  }, `${protocolMessage.idempotencyKey}:event`);
  await database.recordAgentMessage(protocolMessage);
  if (deliveryMode === 'static_history') {
    // Replay-compatible call sites remain explicit historical facts. Only the
    // patched project workflow is allowed to leave a live delivery pending.
    await database.transitionAgentMessage(project.id, protocolMessage.idempotencyKey, 'completed');
  }
  await addIterationCommentOnce(
    project,
    iteration,
    `🟢 **${role} handoff completed.** ${artifactNames} → ${recipients}.`,
    `${protocolMessage.idempotencyKey}:comment`,
  );
  await labelIterationAgent(project, iteration, role);
  return deliveryMode === 'actor_mailbox' ? protocolMessage : undefined;
}

export async function recordAgentFailure(
  projectId: string,
  iterationNumber: number,
  role: AgentRole,
  message: string,
  deliveryMode: AgentMessageDeliveryMode = 'static_history',
): Promise<AgentMessage | undefined> {
  const database = await store();
  await database.addEvent({
    projectId,
    iterationNumber,
    kind: 'system',
    title: `${role} agent needs attention`,
    description: message,
    agentRole: role,
  });
  const protocolMessage = buildAgentFailureMessage(
    projectId,
    iterationNumber,
    role,
    message,
    deliveryMode,
    new Date().toISOString(),
  );
  await database.recordAgentMessage(protocolMessage);
  if (deliveryMode === 'static_history') {
    // Static/replayed failures are not actor deliveries and therefore remain
    // terminal blocker history instead of animating as live traffic.
    await database.transitionAgentMessage(projectId, protocolMessage.idempotencyKey, 'failed');
  }
  return deliveryMode === 'actor_mailbox' ? protocolMessage : undefined;
}

export async function recordIterationReviewProposal(
  projectId: string,
  iterationNumber: number,
  includedRevision: string,
  proposalAttempt?: number,
  gateRationale?: string,
): Promise<IterationReviewProposal> {
  const database = await store();
  const detail = await database.detail(projectId);
  if (!detail) throw new Error(`Iteration ${iterationNumber} was not found for project ${projectId}.`);
  const iteration = detail.iterations.find((candidate) => candidate.number === iterationNumber);
  if (!iteration) throw new Error(`Iteration ${iterationNumber} was not found for project ${projectId}.`);
  const derived = deriveIterationReviewProposal(detail, iterationNumber, includedRevision, gateRationale);
  const operationKey = `iteration:${iteration.id}:review-proposal:${includedRevision}${proposalAttempt === undefined ? '' : `:attempt:${proposalAttempt}`}`;
  const proposal = await database.recordIterationReviewProposal({
    projectId,
    iterationId: iteration.id,
    iterationNumber,
    includedRevision,
    ...derived,
    correlationId: `iteration:${iterationNumber}:review`,
    operationKey,
  });
  await database.addEvent({
    projectId,
    iterationNumber,
    kind: 'review',
    title: 'Manager proposed iteration review',
    description: `${derived.managerRationale} Manager recommendation: ${derived.recommendation.replaceAll('_', ' ')}.`,
    agentRole: 'manager',
  }, operationKey);
  return proposal;
}

export async function supersedeIterationReviewProposal(
  projectId: string,
  iterationNumber: number,
): Promise<boolean> {
  return (await store()).supersedeIterationReviewProposal(projectId, iterationNumber);
}

export type DerivedIterationReviewProposal = Pick<
  IterationReviewProposal,
  | 'objectiveStatus'
  | 'completedOutcomes'
  | 'openFindings'
  | 'agentPositions'
  | 'gateStatus'
  | 'gateRationale'
  | 'managerRationale'
  | 'recommendation'
  | 'knownLimitations'
  | 'budgetSnapshot'
>;

/**
 * Derives the Manager position from the canonical iteration ledger. The Gate
 * status is deliberately `pass`: the workflow calls this activity only after
 * its deterministic structured Gate check succeeds. Everything else remains
 * evidence-derived and bound to the exact runnable revision.
 */
export function deriveIterationReviewProposal(
  detail: ProjectDetail,
  iterationNumber: number,
  includedRevision: string,
  validatedGateRationale?: string,
): DerivedIterationReviewProposal {
  const iteration = detail.iterations.find((candidate) => candidate.number === iterationNumber);
  if (!iteration) throw new Error(`Iteration ${iterationNumber} was not found for project ${detail.project.id}.`);
  const revisionPreview = detail.media.find((media) =>
    media.iterationId === iteration.id
    && media.kind === 'preview'
    && media.sourceRevision === includedRevision
    && (!media.expiresAt || Date.parse(media.expiresAt) > Date.now()));
  if (!revisionPreview) {
    throw new Error(`Iteration ${iterationNumber} has no unexpired preview for revision ${includedRevision}.`);
  }

  const requiredRoles = deliveryAgentGraph.filter((definition) =>
    !('activation' in definition) || definition.activation !== 'authorized_release');
  const evidenceArtifacts = detail.artifacts.filter((artifact) =>
    isCurrentReadinessArtifact(detail, artifact, iteration.id, includedRevision));
  const goals = (detail.agentGoals ?? []).filter((goal) => goal.iterationId === iteration.id);
  const actions = (detail.agentActions ?? []).filter((action) => action.iterationId === iteration.id);
  const obligations = (detail.agentObligations ?? []).filter((obligation) => obligation.iterationId === iteration.id);
  const findings = (detail.findings ?? []).filter((finding) =>
    finding.iterationId === iteration.id
    && ['open', 'acknowledged', 'remediating', 'accepted_risk'].includes(finding.status));
  const pendingQuestions = (detail.questions ?? []).filter((question) =>
    question.status === 'pending' && (question.iterationId === iteration.id || question.iterationId === null));
  const modelInvocations = (detail.modelInvocations ?? []).filter((invocation) => invocation.iterationId === iteration.id);
  const repositoryOperations = (detail.repositoryOperations ?? []).filter((operation) => operation.iterationId === iteration.id);

  const completedOutcomes = [...new Set([
    ...goals.filter((goal) => goal.status === 'satisfied').map((goal) => `Goal satisfied: ${goal.objective}`),
    ...actions.filter((action) => action.status === 'completed').map((action) => `Action completed: ${action.summary}`),
    ...obligations.filter((obligation) => obligation.status === 'satisfied').map((obligation) => `Obligation satisfied: ${obligation.title}`),
    ...evidenceArtifacts.map((artifact) => `${roleDisplayName(artifact.producedBy)} produced ${artifact.name} v${artifact.version}`),
  ])];
  const openFindings: IterationReviewProposal['openFindings'] = findings.map((finding) => ({
    findingId: finding.id,
    severity: finding.severity,
    summary: finding.description ? `${finding.title}: ${finding.description}` : finding.title,
    disposition: proposalFindingDisposition(finding.disposition),
  }));
  const blockingObligations = obligations.filter((obligation) =>
    obligation.mandatory
    && obligation.blocking
    && !['satisfied', 'waived', 'deferred'].includes(obligation.status));
  const blockingFindings = findings.filter((finding) =>
    (finding.severity === 'critical' || finding.severity === 'high')
    && finding.status !== 'accepted_risk'
    && finding.disposition !== 'accepted_risk'
    && finding.disposition !== 'defer_to_next_iteration');

  const agentPositions = Object.fromEntries(organismAgentRolesForProposal().map((role) => {
    if (!requiredRoles.some((definition) => definition.role === role)) return [role, 'not_required'];
    const roleFindings = findings.filter((finding) =>
      finding.ownerRole === role || finding.raisedByRole === role);
    const hasBlockingFinding = roleFindings.some((finding) => blockingFindings.includes(finding));
    const hasBlockingObligation = blockingObligations.some((obligation) => obligation.ownerRole === role);
    if (hasBlockingFinding || hasBlockingObligation) return [role, 'not_ready'];
    if (roleFindings.some((finding) =>
      finding.status === 'accepted_risk' || finding.disposition === 'accepted_risk')) {
      return [role, 'ready_with_accepted_risk'];
    }
    if (roleFindings.length > 0) return [role, 'ready_with_findings'];
    const hasCurrentRevisionEvidence = evidenceArtifacts.some((artifact) => artifact.producedBy === role);
    const requiresRevisionBoundEvidence = role === 'test' || role === 'reviewer' || role === 'gate';
    const hasDurableOutcome = hasCurrentRevisionEvidence || (!requiresRevisionBoundEvidence && (
      goals.some((goal) => goal.role === role && goal.status === 'satisfied')
      || actions.some((action) => action.role === role && action.status === 'completed')
      || obligations.some((obligation) => obligation.ownerRole === role && obligation.status === 'satisfied')
    ));
    return [role, hasDurableOutcome ? 'ready' : 'not_ready'];
  })) as IterationReviewProposal['agentPositions'];
  const notReadyRoles = organismAgentRolesForProposal().filter((role) => agentPositions[role] === 'not_ready');

  const knownLimitations = [...new Set([
    ...openFindings.map((finding) => `${finding.severity}: ${finding.summary} (${finding.disposition.replaceAll('_', ' ')})`),
    ...obligations.filter((obligation) => ['blocked', 'failed', 'waived', 'deferred'].includes(obligation.status))
      .map((obligation) => `${obligation.title}: ${obligation.status.replaceAll('_', ' ')}`),
    ...modelInvocations.filter((invocation) => invocation.status === 'failed')
      .map((invocation) => `${invocation.role ? roleDisplayName(invocation.role) : 'Unassigned'} model invocation failed: ${invocation.error ?? invocation.purpose}`),
    ...repositoryOperations.filter((operation) => operation.status === 'failed' || operation.status === 'conflicted')
      .map((operation) => `Repository operation ${operation.type} ${operation.status}: ${operation.summary}`),
    ...(notReadyRoles.length > 0
      ? [`Required agent positions not ready: ${notReadyRoles.map(roleDisplayName).join(', ')}`]
      : []),
  ])];
  const activeMutationCount = repositoryOperations.filter((operation) =>
    operation.mutating && (operation.status === 'queued' || operation.status === 'running')).length;
  const recommendation: IterationReviewProposal['recommendation'] = pendingQuestions.length > 0
    ? 'request_human_decision'
    : blockingFindings.length > 0 || blockingObligations.length > 0 || activeMutationCount > 0 || notReadyRoles.length > 0
      ? 'continue_iteration'
      : 'send_for_human_review';
  const hasReviewableImplementation = agentPositions.builder !== 'not_ready';
  const objectiveStatus: IterationReviewProposal['objectiveStatus'] = !hasReviewableImplementation
    ? 'unsatisfied'
    : notReadyRoles.length > 0 || blockingFindings.length > 0 || blockingObligations.length > 0
      ? 'partially_satisfied'
      : knownLimitations.length > 0
        ? 'satisfied_with_known_gaps'
        : 'satisfied';
  const managerRationale = `Deterministic Gate passed revision ${includedRevision.slice(0, 12)}. The durable ledger records ${completedOutcomes.length} completed outcome${completedOutcomes.length === 1 ? '' : 's'}, ${openFindings.length} current finding${openFindings.length === 1 ? '' : 's'}, ${pendingQuestions.length} pending human decision${pendingQuestions.length === 1 ? '' : 's'}, and ${activeMutationCount} active repository mutation${activeMutationCount === 1 ? '' : 's'}.`;

  return {
    objectiveStatus,
    completedOutcomes,
    openFindings,
    agentPositions,
    gateStatus: 'pass',
    gateRationale: validatedGateRationale
      ?? `Deterministic Gate checks passed for immutable revision ${includedRevision}.`,
    managerRationale,
    recommendation,
    knownLimitations,
    budgetSnapshot: {
      modelInvocationCount: modelInvocations.length,
      totalTokens: modelInvocations.reduce((total, invocation) => total + invocation.totalTokens, 0),
      openRouterCostUsd: modelInvocations.reduce((total, invocation) =>
        total + (invocation.provider === 'openrouter' ? invocation.costUsd : 0), 0),
      repositoryOperationCount: repositoryOperations.length,
      activeMutationCount,
    },
  };
}

function proposalFindingDisposition(
  disposition: NonNullable<ProjectDetail['findings']>[number]['disposition'],
): IterationReviewProposal['openFindings'][number]['disposition'] {
  if (disposition === 'accepted_risk') return 'accepted_risk';
  if (disposition === 'defer_to_next_iteration') return 'defer_to_next_iteration';
  if (disposition === 'block_iteration' || disposition === 'remediate_current') return 'resolve_in_iteration';
  return 'human_decision_required';
}

function organismAgentRolesForProposal(): AgentRole[] {
  return deliveryAgentGraph.map((definition) => definition.role);
}

function normalizedReviewDecision(decision: IterationReview['decision']): 'approved' | 'changes_requested' {
  return decision === 'approve' || decision === 'approved' ? 'approved' : 'changes_requested';
}

export async function persistIterationReview(
  projectId: string,
  iterationNumber: number,
  review: IterationReview,
  operationKey: string,
  expectedRevision?: string,
  expectedImageDigest?: string,
): Promise<ForgejoIterationLifecycleResult> {
  const approved = normalizedReviewDecision(review.decision) === 'approved';
  if (approved && expectedImageDigest && (
    review.previewAttestation?.revision !== expectedRevision
    || review.previewAttestation?.imageDigest !== expectedImageDigest
  )) {
    throw new Error('Approved preview attestation does not match the checkpoint revision and image digest.');
  }
  const project = await (await store()).find(projectId);
  const iteration = await (await store()).iteration(projectId, iterationNumber);
  await (await store()).reviewIteration(projectId, iterationNumber, review, operationKey);
  const decision = normalizedReviewDecision(review.decision);
  if (!project) {
    return decision === 'changes_requested'
      ? createForgejoLifecycleAdapter({ permissions: new Set() }).changesRequested()
      : { decision: 'approved', merged: false, issueClosed: false, steps: [] };
  }
  const result = await applyIterationReviewLifecycle(
    project,
    iteration,
    decision,
    review.feedback,
    createForgejoLifecycleAdapter(),
    expectedRevision,
  );
  if (decision === 'approved') {
    if (result.merged) await (await store()).completeMergedIteration(projectId, iterationNumber);
    await (await store()).recordRepositoryLifecycle({
      projectId,
      iterationId: iteration.id,
      kind: result.merged ? 'pull_request_merged' : 'operation_failed',
      status: result.merged ? 'completed' : 'failed',
      repositoryUrl: project.repositoryUrl,
      externalId: iteration.pullRequestNumber === null ? null : String(iteration.pullRequestNumber),
      summary: result.merged
        ? `Approved pull request #${iteration.pullRequestNumber} was merged into main.`
        : 'The approved pull request merge was not confirmed.',
      metadata: { issueClosed: result.issueClosed, expectedRevision, expectedImageDigest, steps: result.steps },
    }, `${operationKey}:forgejo-review:${result.merged ? 'merged' : 'failed'}`);
  }
  await (await store()).addEvent({
    projectId,
    iterationNumber,
    kind: 'review',
    title: decision === 'approved'
      ? result.merged ? 'Approved pull request merged' : 'Approved merge needs attention'
      : 'Changes retained on the open pull request',
    description: result.steps.map((step) => `${step.action}: ${step.status} (${step.detail})`).join(' '),
    agentRole: 'gate',
  }, `${operationKey}:forgejo-review-event:${decision}:${result.merged ? 'merged' : 'pending'}`);
  return result;
}

export async function finalizeApprovedIterationDelivery(
  projectId: string,
  iterationNumber: number,
  operationKey: string,
  expectedRevision?: string,
  expectedImageDigest?: string,
): Promise<ForgejoIterationLifecycleResult> {
  const project = await (await store()).find(projectId);
  const iteration = await (await store()).iteration(projectId, iterationNumber);
  if (!project) return { decision: 'approved', merged: false, issueClosed: false, steps: [] };
  const result = await createForgejoLifecycleAdapter().finalizeApprovedIteration(project, iteration, {
    decision: 'approved',
    approvedBy: 'human',
    expectedRevision,
  });
  if (result.merged) await (await store()).completeMergedIteration(projectId, iterationNumber);
  await (await store()).recordRepositoryLifecycle({
    projectId,
    iterationId: iteration.id,
    kind: result.merged ? 'pull_request_merged' : 'operation_failed',
    status: result.merged ? 'completed' : 'failed',
    repositoryUrl: project.repositoryUrl,
    externalId: iteration.pullRequestNumber === null ? null : String(iteration.pullRequestNumber),
    summary: result.merged
      ? `Approved pull request #${iteration.pullRequestNumber} was merged into main.`
      : 'The approved pull request merge retry was not confirmed.',
    metadata: { issueClosed: result.issueClosed, expectedRevision, expectedImageDigest, steps: result.steps },
  }, `${operationKey}:forgejo-finalize:${result.merged ? 'merged' : 'failed'}`);
  await (await store()).addEvent({
    projectId,
    iterationNumber,
    kind: 'review',
    title: result.merged ? 'Approved pull request merged' : 'Approved merge retry needs attention',
    description: result.steps.map((step) => `${step.action}: ${step.status} (${step.detail})`).join(' '),
    agentRole: 'gate',
  }, `${operationKey}:forgejo-finalize-event:${result.merged ? 'merged' : 'failed'}`);
  return result;
}

export async function prepareIterationReview(project: Project, iterationNumber: number): Promise<ProjectIteration> {
  const iteration = await (await store()).iteration(project.id, iterationNumber);
  const pullWasNew = !iteration.pullRequestNumber;
  const pull = await createIterationPullRequest(project, iteration);
  const updated = await (await store()).updateIterationDelivery(iteration.id, {
    pullRequestNumber: pull.number,
    pullRequestUrl: pull.url,
  });
  await (await store()).addEvent({
    projectId: project.id, iterationNumber, kind: 'review', title: 'Pull request ready for review',
    description: `The iteration delivery package is available as pull request #${pull.number}.`, agentRole: 'gate',
  });
  await labelIterationStatus(project, updated, 'review-pending');
  if (pullWasNew) {
    await (await store()).recordRepositoryLifecycle({
      projectId: project.id,
      iterationId: iteration.id,
      kind: 'pull_request_opened',
      status: 'completed',
      repositoryUrl: project.repositoryUrl,
      externalId: String(pull.number),
      summary: `Pull request #${pull.number} is ready for human review.`,
      metadata: { url: pull.url, issueNumber: iteration.issueNumber },
    });
  }
  return updated;
}

export async function recordUserFlowMedia(
  project: Project,
  iteration: ProjectIteration,
  recording: { title: string; url: string },
  preview?: PreviewDeploymentResult,
  operationKey?: string,
): Promise<void> {
  const database = await store();
  await database.addMedia({
    projectId: project.id,
    iterationId: iteration.id,
    kind: 'user_flow_video',
    title: recording.title,
    url: recording.url,
    sourceRevision: preview?.revision ?? null,
    imageDigest: preview?.imageDigest ?? null,
    expiresAt: preview?.expiresAt ?? null,
  }, operationKey);
  await database.addEvent({
    projectId: project.id, iterationNumber: iteration.number, kind: 'artifact',
    title: 'User-flow recording is ready', description: 'The Test agent captured the latest runnable preview and committed the WebM evidence to Forgejo.', agentRole: 'test',
  }, operationKey ? `${operationKey}:event` : undefined);
}

export interface LegacyIterationPreviewDeployment {
  title: string;
  url: string;
  source: 'existing' | 'adapter';
}

export type IterationPreviewDeployment = PreviewDeploymentResult | LegacyIterationPreviewDeployment;

export interface ExistingIterationPreview {
  iterationId: string;
  title: string;
  url: string;
}

export function selectIterationPreview(
  detail: ProjectDetail,
  iterationId: string,
): ExistingIterationPreview | undefined {
  const preview = detail.media.find((media) =>
    media.kind === 'preview' && media.iterationId === iterationId);
  return preview ? { iterationId, title: preview.title, url: preview.url } : undefined;
}

export async function getIterationPreview(
  projectId: string,
  iterationId: string,
): Promise<ExistingIterationPreview | undefined> {
  const detail = await (await store()).detail(projectId);
  return detail ? selectIterationPreview(detail, iterationId) : undefined;
}

export async function recordIterationPreview(
  project: Project,
  iteration: ProjectIteration,
  preview: IterationPreviewDeployment,
): Promise<Project> {
  const database = await store();
  const revisionBound = 'revision' in preview;
  const previewUrl = revisionBound ? preview.publicUrl : preview.url;
  await database.recordRepositoryLifecycle({
    projectId: project.id,
    iterationId: iteration.id,
    kind: 'deployment_started',
    status: 'completed',
    repositoryUrl: project.repositoryUrl,
    externalId: `preview:${iteration.number}`,
    summary: `Preview resolution started from the ${preview.source} source.`,
    metadata: {
      source: preview.source,
      ...(revisionBound ? {
        revision: preview.revision,
        imageDigest: preview.imageDigest,
        expiresAt: preview.expiresAt,
      } : {}),
    },
  });
  const updated = await database.updatePreviewUrl(project.id, previewUrl);
  const detail = await database.detail(project.id);
  const alreadyRecorded = detail?.media.some((media) =>
    media.kind === 'preview'
      && media.iterationId === iteration.id
      && media.url === previewUrl
      && (!revisionBound || media.sourceRevision === preview.revision));
  if (!alreadyRecorded) {
    await database.addMedia({
      projectId: project.id,
      iterationId: iteration.id,
      kind: 'preview',
      title: preview.title,
      url: previewUrl,
      sourceRevision: revisionBound ? preview.revision : null,
      imageDigest: revisionBound ? preview.imageDigest : null,
      expiresAt: revisionBound ? preview.expiresAt : null,
    });
  }
  await database.addEvent({
    projectId: project.id,
    iterationNumber: iteration.number,
    kind: 'system',
    title: 'Iteration preview is available',
    description: `${preview.source === 'existing' ? 'Existing' : 'Adapter-provided'} preview: ${previewUrl}`,
    agentRole: null,
  });
  await database.recordRepositoryLifecycle({
    projectId: project.id,
    iterationId: iteration.id,
    kind: 'deployment_completed',
    status: 'completed',
    repositoryUrl: project.repositoryUrl,
    externalId: revisionBound ? preview.revision : previewUrl,
    summary: 'The iteration preview URL was persisted for Test and human review.',
    metadata: {
      source: preview.source,
      previewUrl,
      ...(revisionBound ? {
        revision: preview.revision,
        imageDigest: preview.imageDigest,
        expiresAt: preview.expiresAt,
      } : {}),
    },
  });
  return updated;
}

export async function recordPreviewUnavailable(
  projectId: string,
  iterationNumber: number,
  reason: string,
): Promise<void> {
  const database = await store();
  const iteration = await database.iteration(projectId, iterationNumber);
  const project = await database.find(projectId);
  await database.addEvent({
    projectId,
    iterationNumber,
    kind: 'system',
    title: 'Iteration preview unavailable',
    description: reason,
    agentRole: null,
  });
  await database.recordRepositoryLifecycle({
    projectId,
    iterationId: iteration.id,
    kind: 'operation_failed',
    status: 'failed',
    repositoryUrl: project?.repositoryUrl ?? null,
    externalId: `preview:${iterationNumber}`,
    summary: 'No runnable preview was available; no visual execution evidence was fabricated.',
    metadata: { reason },
  });
}

export interface DiscoveryPlan {
  summary: string;
  questions: string[];
  proposedMilestones: string[];
}

export async function prepareDiscovery(project: Project): Promise<DiscoveryPlan> {
  return {
    summary: `${project.name} serves ${project.audience}. Success means: ${project.success}`,
    questions: [
      'What is the smallest useful result a first user should reach?',
      'What information is sensitive or regulated?',
      'Which decisions must always require human approval?',
    ],
    proposedMilestones: ['Confirm intent', 'Approve product brief', 'Build first walking skeleton', 'Review a live preview'],
  };
}
