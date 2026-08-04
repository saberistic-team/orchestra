import { deliveryAgentGraph, resolveModelConcurrency, type AgentArtifactDraft, type AgentArtifactReference, type AgentCommentInput, type AgentExecutionGraph, type AgentInteraction, type AgentInteractionKind, type AgentInteractionParty, type AgentInteractionStatus, type AgentQuestion, type AgentQuestionAnswerInput, type AgentRole, type ArtifactFeedbackInput, type DeliveryAgentDefinition, type IterationReview, type PreviewDeploymentResult, type Project, type ProjectArtifact, type ProjectBrief, type ProjectDetail, type ProjectEvent, type ProjectIteration, type ProjectStatus, type ProjectSummary } from '@orchestra/contracts';
import { resolveModelProvider } from '@orchestra/contracts';
import { defaultMigrationsFolder, normalizeDecisionKey, ProjectStore } from '@orchestra/database';
import { addIterationComment, agentCommitSummary, applyIterationReviewLifecycle, commitArtifact, createForgejoLifecycleAdapter, createIterationIssue, createIterationPullRequest, ensureProjectLifecycleLabels, ensureProjectRepository, labelIterationAgent, labelIterationStatus, type ForgejoIterationLifecycleResult } from './forgejo.js';

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
  return detail ? { ...detail, executionGraph: buildExecutionGraph(detail) } : undefined;
}

export interface StoredHumanGuidance {
  key: string;
  kind: 'question_answer' | 'agent_comment' | 'artifact_feedback' | 'overall_direction' | 'agent_feedback';
  summary: string;
  role?: AgentRole;
}

/**
 * Rebuilds model-facing human context from durable project records. Decisions
 * are project-wide and the latest answer for a canonical key is authoritative;
 * role comments and iteration agent feedback remain scoped to that role.
 */
export async function getProjectHumanGuidance(projectId: string): Promise<StoredHumanGuidance[]> {
  const detail = await (await store()).detail(projectId);
  if (!detail) return [];
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
  return guidance.slice(0, 100);
}

function artifactTypeMatches(pattern: string, type: string) {
  return pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}

/**
 * Selects the newest relevant artifact versions from completed earlier
 * iterations. Kept pure so the history/context boundary can be unit tested.
 */
export function selectPriorAgentArtifacts(
  detail: ProjectDetail,
  iterationNumber: number,
  consumes: readonly string[],
): AgentArtifactReference[] {
  const iterationNumbers = new Map(detail.iterations.map((iteration) => [iteration.id, iteration.number]));
  const revisingCurrentIteration = detail.iterations.some((iteration) =>
    iteration.number === iterationNumber
      && (iteration.status === 'changes_requested' || iteration.status === 'blocked'));
  const selected = detail.artifacts
    .filter((artifact) => {
      const artifactIteration = iterationNumbers.get(artifact.iterationId) ?? iterationNumber;
      return artifactIteration < iterationNumber || (revisingCurrentIteration && artifactIteration === iterationNumber);
    })
    .filter((artifact) => consumes.some((pattern) => artifactTypeMatches(pattern, artifact.type)))
    .sort((left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt));
  const newestByType = new Map<string, ProjectArtifact>();
  for (const artifact of selected) {
    if (!newestByType.has(artifact.type)) newestByType.set(artifact.type, artifact);
  }
  return [...newestByType.values()].slice(0, 20).map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    name: artifact.name,
    content: artifact.content.slice(0, 4_000),
    mimeType: artifact.mimeType,
    producedBy: artifact.producedBy,
    repositoryUrl: artifact.repositoryUrl,
  }));
}

export async function getPriorAgentArtifacts(
  projectId: string,
  iterationNumber: number,
  consumes: readonly string[],
): Promise<AgentArtifactReference[]> {
  const detail = await (await store()).detail(projectId);
  return detail ? selectPriorAgentArtifacts(detail, iterationNumber, consumes) : [];
}

export function buildExecutionGraph(detail: ProjectDetail): AgentExecutionGraph {
  const iterationNumber = detail.project.currentIteration;
  const iteration = detail.iterations.find((candidate) => candidate.number === iterationNumber);
  const artifacts = detail.artifacts.filter((artifact) => artifact.iterationId === iteration?.id);
  const events = detail.events.filter((event) => event.iterationNumber === iterationNumber);
  const completedRoles = new Set(deliveryAgentGraph.filter((step) =>
    artifacts.some((artifact) => artifact.producedBy === step.role && artifact.type === step.artifactType),
  ).map((step) => step.role));

  const nodes = deliveryAgentGraph.map((step) => {
    const completedArtifact = artifacts.find((artifact) => artifact.producedBy === step.role && artifact.type === step.artifactType);
    const startedEvent = events.find((event) => event.agentRole === step.role && event.kind === 'agent' && event.title.toLowerCase().includes('started'));
    const failedEvent = events.find((event) => event.agentRole === step.role && event.kind === 'system' && event.title.toLowerCase().includes('needs attention'));
    const completedAfterStart = completedArtifact && (!startedEvent || completedArtifact.createdAt >= startedEvent.createdAt);
    const failedAfterStart = failedEvent && (!startedEvent || failedEvent.createdAt >= startedEvent.createdAt);
    const awaitsReleaseAuthorization = (step as DeliveryAgentDefinition).activation === 'authorized_release' && !startedEvent && !completedArtifact;
    const state: AgentExecutionGraph['nodes'][number]['state'] = completedAfterStart ? 'completed'
      : failedAfterStart ? 'blocked'
        : startedEvent ? 'active'
          : awaitsReleaseAuthorization ? 'dormant'
          : step.dependsOn.every((dependency) => completedRoles.has(dependency)) ? 'ready' : 'waiting';
    return {
      role: step.role,
      label: step.label,
      icon: step.icon,
      phase: step.phase,
      state,
      assignedModel: completedArtifact?.model ?? 'resolved when agent starts',
      assignedProvider: completedArtifact?.modelProvider ?? resolveModelProvider(step.role, process.env),
      artifactType: step.artifactType,
      artifactName: step.artifactName,
      dependsOn: [...step.dependsOn],
      supervisedBy: [...step.supervisedBy],
      consumes: [...step.consumes],
      produces: [...step.produces],
      startedAt: startedEvent?.createdAt ?? null,
      completedAt: completedArtifact?.createdAt ?? null,
    };
  });
  const edges: AgentExecutionGraph['edges'] = [];
  for (const target of deliveryAgentGraph) {
    for (const sourceRole of target.dependsOn) {
      const source = deliveryAgentGraph.find((candidate) => candidate.role === sourceRole)!;
      edges.push({
        from: sourceRole,
        to: target.role,
        kind: 'blocks',
        artifacts: source.produces.filter((produced) => target.consumes.some((consumed) =>
          artifactTypeMatches(consumed, produced) || artifactTypeMatches(produced, consumed),
        )),
      });
    }
    for (const supervisor of target.supervisedBy) {
      if (!edges.some((edge) => edge.from === supervisor && edge.to === target.role && edge.kind === 'supervises')) {
        edges.push({ from: supervisor, to: target.role, kind: 'supervises', artifacts: [] });
      }
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
    interactions: buildAgentInteractions(detail, completedRoles),
  };
}

function buildAgentInteractions(detail: ProjectDetail, completedRoles: Set<AgentRole>): AgentInteraction[] {
  return detail.events.map((event) => {
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
      correlationId: `iteration:${event.iterationNumber ?? detail.project.currentIteration}`,
      iterationNumber: event.iterationNumber ?? detail.project.currentIteration,
      from,
      to: interactionRecipients(event, from, kind),
      kind,
      name: event.title,
      summary: event.description,
      status,
      createdAt: event.createdAt,
      artifactRefs: references.length > 0 ? references : undefined,
      live: status === 'in_progress' || status === 'blocked',
    } satisfies AgentInteraction;
  });
}

function interactionSender(event: ProjectEvent, normalized: string): AgentInteractionParty {
  if (event.kind === 'system' && /block|fail|needs attention|unavailable/.test(normalized)) return 'system';
  if (event.agentRole) return event.agentRole;
  if (event.kind === 'project' || event.kind === 'review') return 'human';
  if (event.kind === 'deployment') return 'deployment';
  return 'system';
}

function interactionKind(event: ProjectEvent, normalized: string): AgentInteractionKind {
  if (event.kind === 'review') return /finding|change|defect|issue/.test(normalized) ? 'finding' : 'decision';
  if (event.kind === 'artifact') return /test|evidence|report|decision/.test(normalized) ? 'evidence' : 'handoff';
  if (event.kind === 'project') return /approv|reject|decision/.test(normalized) ? 'decision' : 'order';
  if (event.kind === 'system') return 'control';
  if (event.kind === 'deployment') return 'handoff';
  return /handoff|publish|deliver/.test(normalized) ? 'handoff' : 'status';
}

function interactionStatus(
  event: ProjectEvent,
  normalized: string,
  roleCompleted: boolean,
): AgentInteractionStatus {
  if (/reject|declin/.test(normalized)) return 'rejected';
  if (/block|fail|cannot|needs attention|unavailable/.test(normalized)) return 'blocked';
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
  for (const artifact of detail?.artifacts.filter((item) => item.iterationId === iteration.id && !item.repositoryUrl) ?? []) {
    const location = await commitArtifact(project, prepared, artifact);
    const located = await (await store()).locateArtifact(artifact.id, location.path, location.url);
    await addIterationComment(project, prepared, agentCommitSummary(artifact.producedBy, located));
  }
  return prepared;
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
  await (await store()).addEvent({
    projectId: project.id,
    iterationNumber: iteration.number,
    kind: 'agent',
    title: `${role[0].toUpperCase()}${role.slice(1)} agent started`,
    description: `The ${role} agent is working from its approved dependencies.${handoff}${supervision}`,
    agentRole: role,
  });
  const received = inputArtifacts?.length ? ` Received: ${inputArtifacts.map((artifact) => `[${artifact.name}](${artifact.repositoryUrl ?? project.repositoryUrl})`).join(', ')}.` : '';
  await addIterationComment(project, iteration, `🟠 **${role} agent started** using its dedicated Temporal workflow.${received}${supervision}`);
}

export interface RecordedAgentArtifacts {
  artifacts: ProjectArtifact[];
  questionIds: string[];
}

export async function recordAgentArtifact(
  project: Project,
  iteration: ProjectIteration,
  draft: AgentArtifactDraft,
): Promise<RecordedAgentArtifacts> {
  const drafts: AgentArtifactDraft[] = [draft, ...(draft.attachments ?? []).map((attachment) => ({
    ...attachment,
    producedBy: draft.producedBy,
    model: draft.model,
    modelProvider: draft.modelProvider,
    modelInvocations: draft.modelInvocations,
  }))];
  const saved: ProjectArtifact[] = [];
  for (const item of drafts) {
    const artifact = await (await store()).addArtifact(project.id, iteration.id, item, iteration.number);
    const location = await commitArtifact(project, iteration, artifact);
    const located = await (await store()).locateArtifact(artifact.id, location.path, location.url);
    if (!iteration.branchName) iteration.branchName = location.branch;
    saved.push(located);
    await addIterationComment(project, iteration, agentCommitSummary(draft.producedBy, located));
  }
  const questionIds: string[] = [];
  for (const question of draft.questions ?? []) {
    const persisted = await (await store()).addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: draft.producedBy,
      ...question,
    });
    questionIds.push(persisted.id);
  }
  await labelIterationAgent(project, iteration, draft.producedBy);
  return { artifacts: saved, questionIds };
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

export async function persistAgentComment(comment: AgentCommentInput): Promise<void> {
  const database = await store();
  await database.addAgentComment(comment);
  await database.addEvent({
    projectId: comment.projectId,
    iterationNumber: null,
    kind: 'project',
    title: `Human direction for the ${comment.agentRole} agent`,
    description: comment.body,
    agentRole: comment.agentRole,
  });
}

export async function persistArtifactFeedback(projectId: string, feedback: ArtifactFeedbackInput): Promise<AgentRole> {
  const database = await store();
  const detail = await database.detail(projectId);
  const artifact = detail?.artifacts.find((candidate) => candidate.id === feedback.artifactId);
  if (!artifact) throw new Error('Artifact was not found for this project.');
  await database.addProjectArtifactFeedback(projectId, feedback);
  await database.addEvent({
    projectId,
    iterationNumber: null,
    kind: 'review',
    title: `Human feedback on ${artifact.name}`,
    description: feedback.feedback || 'The artifact was reviewed with no additional written feedback.',
    agentRole: artifact.producedBy,
  });
  return artifact.producedBy;
}

export async function recordAgentHandoff(
  project: Project,
  iteration: ProjectIteration,
  role: AgentRole,
  artifacts: ProjectArtifact[],
  handsOffTo: AgentRole[],
): Promise<void> {
  const artifactNames = artifacts.map((artifact) => artifact.name).join(', ');
  const recipients = handsOffTo.length ? handsOffTo.join(', ') : 'the human review gate';
  await (await store()).addEvent({
    projectId: project.id,
    iterationNumber: iteration.number,
    kind: 'agent',
    title: `${role[0].toUpperCase()}${role.slice(1)} handoff completed`,
    description: `${artifactNames} were committed to the shared branch and handed to ${recipients}.`,
    agentRole: role,
  });
  await addIterationComment(project, iteration, `🟢 **${role} handoff completed.** ${artifactNames} → ${recipients}.`);
  await labelIterationAgent(project, iteration, role);
}

export async function recordAgentFailure(projectId: string, iterationNumber: number, role: AgentRole, message: string): Promise<void> {
  await (await store()).addEvent({
    projectId,
    iterationNumber,
    kind: 'system',
    title: `${role} agent needs attention`,
    description: message,
    agentRole: role,
  });
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
): Promise<void> {
  await (await store()).addMedia({
    projectId: project.id,
    iterationId: iteration.id,
    kind: 'user_flow_video',
    title: recording.title,
    url: recording.url,
    sourceRevision: preview?.revision ?? null,
    imageDigest: preview?.imageDigest ?? null,
    expiresAt: preview?.expiresAt ?? null,
  });
  await (await store()).addEvent({
    projectId: project.id, iterationNumber: iteration.number, kind: 'artifact',
    title: 'User-flow recording is ready', description: 'The Test agent captured the latest runnable preview and committed the WebM evidence to Forgejo.', agentRole: 'test',
  });
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
