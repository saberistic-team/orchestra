import {
  organismAgentRoles,
  type AgentExecutionState,
  type AgentInteraction,
  type AgentInteractionKind,
  type AgentMessage,
  type AgentOrder,
  type AgentRuntimeSnapshot,
  type AgentActionPlanRecord,
  type AgentActionRecord,
  type AgentGoalRecord,
  type AgentObligationRecord,
  type AgentArtifactDraft,
  type AgentComment,
  type AgentCommentInput,
  type AgentQuestion,
  type AgentQuestionAnswer,
  type AgentQuestionAnswerInput,
  type AgentQuestionInput,
  type AgentRole,
  type ArtifactFeedback,
  type ArtifactFeedbackInput,
  type ArtifactVersionRecord,
  type DynamicExecutionTrace,
  type FindingRecord,
  type IterationReview,
  type IterationReviewProposal,
  type IterationReviewBudgetSnapshot,
  type IterationReviewRecord,
  type Project,
  type ProjectArtifact,
  type ProjectBrief,
  type ProjectDetail,
  type ProjectEvent,
  type ProjectIteration,
  type ProjectMedia,
  type ProjectStatus,
  type ProjectSummary,
  type ModelInvocationRecord,
  type RepositoryLifecycleInput,
  type RepositoryLifecycleRecord,
  type RepositoryOperationRecord,
} from '@orchestra/contracts';
import { and, count, desc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

const FINDING_REPEAT_COOLDOWN_MS = 30_000;

export function normalizeDecisionKey(value: string) {
  const raw = value.toLowerCase().trim();
  const normalized = raw.replace(/[-_]+/gu, '.');
  const aliases: Record<string, string> = {
    'accessibility.wcag.baseline': 'accessibility.wcag_baseline',
    'findings.severity.taxonomy': 'findings.severity_taxonomy',
    'security.evidence.protection': 'security.evidence_protection',
    'authentication.invite.flow': 'authentication.invite_flow',
    'authentication.implementation.model': 'authentication.implementation_model',
    'auth.model.selection': 'authentication.implementation_model',
    'auth.iteration1.implementation.model': 'authentication.implementation_model',
    'auth.invite.method': 'authentication.invite_flow',
    'authentication.invite.method': 'authentication.invite_flow',
    'export.format.choice': 'export.format',
    'exports.package.format': 'export.format',
    'exports.format': 'export.format',
  };
  return aliases[normalized] ?? raw;
}

function canonicalDecisionKey(input: AgentQuestionInput) {
  const searchable = `${input.question} ${input.options.map((option) => `${option.value} ${option.label}`).join(' ')}`.toLowerCase();
  if (searchable.includes('wcag')) return 'accessibility.wcag_baseline';
  if (searchable.includes('severity')) return 'findings.severity_taxonomy';
  if (searchable.includes('evidence') && /(protect|storage|encrypt|link-only)/u.test(searchable)) {
    return 'security.evidence_protection';
  }
  if (searchable.includes('export') && /(format|package|handoff)/u.test(searchable)) return 'export.format';
  if (/(auth|sign-in|login)/u.test(searchable) && /(invite|one-time|passwordless)/u.test(searchable)) {
    return 'authentication.invite_flow';
  }
  if (/(auth|sign-in|login)/u.test(searchable) && /(model|method|credential|oidc|ldap)/u.test(searchable)) {
    return 'authentication.implementation_model';
  }
  if (input.decisionKey) return normalizeDecisionKey(input.decisionKey);
  const normalized = input.question.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
  return `question.${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

function canonicalDecisionValue(decisionKey: string, value: string) {
  decisionKey = normalizeDecisionKey(decisionKey);
  const normalized = value.toLowerCase().replace(/[_/]+/gu, '-');
  if (decisionKey === 'accessibility.wcag_baseline') {
    if (/2[.-]?2/u.test(normalized)) return 'wcag-2.2-aa';
    if (/2[.-]?1/u.test(normalized)) return 'wcag-2.1-aa';
  }
  if (decisionKey === 'findings.severity_taxonomy') {
    if (normalized.includes('critical') && normalized.includes('high')) return 'four-level';
    if (normalized.includes('blocker') && normalized.includes('major')) return 'three-level';
    if (normalized.includes('impact')) return 'impact-based';
  }
  if (decisionKey === 'security.evidence_protection') {
    if (normalized.includes('client-side')) return 'client-side-encryption';
    if (normalized.includes('metadata-only')) return 'metadata-only';
    if (/(encrypt-at-rest|encrypt-storage|server-side|aes-?256)/u.test(normalized)) return 'encrypt-at-rest';
    if (normalized.includes('customer-managed')) return 'customer-managed-keys';
    if (normalized.includes('infrastructure')) return 'infrastructure-encryption';
    if (normalized.includes('link-only')) return 'link-only';
    if (normalized.includes('hybrid')) return 'hybrid';
  }
  if (decisionKey === 'export.format') {
    if (normalized.includes('pdf') && /(json|manifest|provenance)/u.test(normalized)) return 'pdf-plus-json';
    if (normalized.includes('markdown') && normalized.includes('html') && /(json|manifest|provenance)/u.test(normalized)) {
      return 'markdown-html-json';
    }
  }
  if (decisionKey === 'authentication.invite_flow') {
    if (/(one-time|passwordless|magic)/u.test(normalized)) return 'one-time-link';
    if (normalized.includes('sso')) return 'sso';
    if (/(local-account|password)/u.test(normalized)) return 'local-password';
  }
  if (decisionKey === 'authentication.implementation_model') {
    if (normalized.includes('oidc')) return 'oidc';
    if (normalized.includes('ldap')) return 'ldap';
    if (/(local|username|password)/u.test(normalized)) return 'local';
    if (/(stub|mock)/u.test(normalized)) return 'stub';
  }
  return normalized.trim();
}

function reusableAnswer(source: AgentQuestion, target: AgentQuestion): AgentQuestionAnswerInput | undefined {
  const answer = source.answer;
  const sourceDecisionKey = normalizeDecisionKey(source.decisionKey);
  const targetDecisionKey = normalizeDecisionKey(target.decisionKey);
  if (!answer || sourceDecisionKey !== targetDecisionKey) return undefined;
  if (answer.resolution === 'custom') {
    return target.allowCustomAnswer ? { resolution: 'custom', answer: answer.answer } : undefined;
  }
  if (answer.resolution === 'agent_decides') {
    return target.allowAgentDecide ? { resolution: 'agent_decides' } : undefined;
  }
  const sourceOption = source.options.find((option) => option.id === answer.optionId);
  if (!sourceOption) return undefined;
  const selectedValue = canonicalDecisionValue(
    sourceDecisionKey,
    `${sourceOption.value} ${sourceOption.label} ${sourceOption.description ?? ''}`,
  );
  const targetOption = target.options.find((option) =>
    canonicalDecisionValue(
      targetDecisionKey,
      `${option.value} ${option.label} ${option.description ?? ''}`,
    ) === selectedValue,
  );
  return targetOption ? { resolution: 'selected_option', optionId: targetOption.id } : undefined;
}

export const defaultMigrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

type AddProjectMediaInput = Omit<
  ProjectMedia,
  'id' | 'createdAt' | 'sourceRevision' | 'imageDigest' | 'expiresAt'
> & Partial<Pick<ProjectMedia, 'sourceRevision' | 'imageDigest' | 'expiresAt'>>;

export interface RecordAgentRuntimeStateInput {
  projectId: string;
  iterationId?: string | null;
  role: AgentRole;
  state: AgentExecutionState;
  stateVersion: number;
  activity?: { type: string; summary: string } | null;
  waitingReason?: string;
  blockerReferences?: string[];
  modelProvider?: 'ollama' | 'openrouter';
  model?: string;
  workflowRunId?: string;
  correlationId?: string;
  operationKey: string;
  enteredAt?: string;
}

export interface RecordIterationReviewProposalInput {
  projectId: string;
  iterationId: string;
  iterationNumber: number;
  includedRevision: string;
  objectiveStatus: IterationReviewProposal['objectiveStatus'];
  completedOutcomes: string[];
  openFindings: IterationReviewProposal['openFindings'];
  agentPositions: IterationReviewProposal['agentPositions'];
  gateStatus: IterationReviewProposal['gateStatus'];
  gateRationale: string;
  managerRationale: string;
  recommendation: IterationReviewProposal['recommendation'];
  knownLimitations: string[];
  budgetSnapshot: IterationReviewBudgetSnapshot;
  correlationId: string;
  operationKey: string;
}

export type AgentMessageTransition = 'delivered' | 'acknowledged' | 'completed' | 'failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericLedgerValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function messagePayloadSummary(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const summary = payload.summary;
  if (typeof summary === 'string' && summary.trim()) return summary.trim();
  const input = payload.input;
  if (isRecord(input)) {
    const artifactName = input.artifactName;
    if (typeof artifactName === 'string' && artifactName.trim()) return `Execute the bounded ${artifactName.trim()} order.`;
  }
  return undefined;
}

function messagePayloadIterationNumber(payload: unknown): number | undefined {
  if (!isRecord(payload) || !isRecord(payload.input) || !isRecord(payload.input.iteration)) return undefined;
  const number = payload.input.iteration.number;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : undefined;
}

function safeMessagePayload(payload: unknown): Record<string, unknown> {
  if (isRecord(payload)) return payload;
  return payload === undefined ? {} : { value: payload };
}

function protocolMessageType(message: AgentMessage): typeof schema.agentMessageTypes[number] {
  if (message.name.includes('review.proposal')) return 'review_proposal';
  if (message.name.includes('revision')) return 'revision_request';
  if (message.name.includes('handoff')) return 'handoff';
  if (message.name.includes('acknowledge')) return 'acknowledgement';
  const kinds: Record<AgentMessage['kind'], typeof schema.agentMessageTypes[number]> = {
    COMMAND: 'order',
    EVENT: 'status',
    QUESTION: 'question',
    RESPONSE: 'answer',
    DECISION: 'decision',
    EVIDENCE: 'evidence',
    FINDING: 'finding',
    STATUS: 'status',
    ESCALATION: 'blocker',
    CONTROL: 'request',
  };
  return kinds[message.kind];
}

function sourceOperationKey(table: string, id: string, suffix?: string): string {
  return `v1:source:${table}:${id}${suffix ? `:${suffix}` : ''}`;
}

function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (!isRecord(input)) return input;
    return Object.fromEntries(Object.entries(input)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]));
  };
  return JSON.stringify(canonicalize(value));
}

function dynamicExecutionModelInvocationOperationKey(
  executionId: string,
  invocationIndex: number,
): string {
  const executionKey = createHash('sha256').update(executionId).digest('hex');
  return `v1:dynamic-execution:${executionKey}:model-invocation:${invocationIndex}`;
}

export interface AddArtifactPersistenceOptions {
  /** Hash of the complete root draft, including attachments and questions. */
  operationManifestHash?: string;
  /** Stable root identity used to distinguish otherwise identical model calls. */
  modelInvocationOperationPrefix?: string;
  /** Dynamic execution identity shared with terminal-state invocation auditing. */
  modelInvocationExecutionId?: string;
  /** Complete private root snapshot used to resume an interrupted operation. */
  operationPayload?: AgentArtifactDraft;
  /** Keep the artifact non-reviewable until its repository location is durable. */
  stageForRepository?: boolean;
  /** Durable storage intent; ledger-only evidence must not be swept into Git. */
  storage?: 'repository' | 'ledger';
  /** Immutable candidate revision this evidence attests. */
  sourceRevision?: string;
}

export interface ArtifactOperationRecoveryEnvelope {
  iterationId: string;
  type: string;
  producedBy: AgentRole;
  storage: 'repository' | 'ledger';
  sourceRevision: string | null;
}

export interface CompleteArtifactPersistenceOptions {
  executionTrace?: AgentArtifactDraft['executionTrace'];
  iterationNumber: number | null;
  eventOperationKey?: string;
}

function assertCompatibleArtifactReplay(
  row: typeof schema.artifacts.$inferSelect,
  projectId: string,
  iterationId: string,
  draft: AgentArtifactDraft,
  operationKey: string,
  options?: AddArtifactPersistenceOptions,
): void {
  if (row.projectId !== projectId
    || row.iterationId !== iterationId
    || row.type !== draft.type
    || row.name !== draft.name
    || row.content !== draft.content
    || row.mimeType !== draft.mimeType
    || row.producedBy !== draft.producedBy
    || row.model !== (draft.model ?? null)
    || row.modelProvider !== (draft.modelProvider ?? null)
    || canonicalJson(row.modelInvocations ?? null) !== canonicalJson(draft.modelInvocations ?? null)
    || row.operationManifestHash !== (options?.operationManifestHash ?? null)
    || row.storageMode !== (options?.storage ?? 'repository')
    || (!options?.stageForRepository
      && canonicalJson(row.executionTrace ?? null) !== canonicalJson(draft.executionTrace ?? null))) {
    throw new Error(`Artifact operation ${operationKey} was already used with a different payload.`);
  }
}

function repositoryOperationStatus(
  status: RepositoryLifecycleInput['status'],
): typeof schema.repositoryOperationStatuses[number] {
  return status === 'pending' ? 'queued' : status;
}

function repositoryOperationIsMutating(kind: RepositoryLifecycleInput['kind']): boolean {
  return [
    'branch_created',
    'pull_request_opened',
    'pull_request_updated',
    'pull_request_merged',
    'deployment_started',
    'deployment_completed',
    'repository_archived',
  ].includes(kind);
}

function repositoryOperationValues(
  row: typeof schema.repositoryLifecycleRecords.$inferSelect,
): typeof schema.repositoryOperations.$inferInsert {
  const metadata = row.metadata;
  const metadataString = (...keys: string[]) => {
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
  };
  const rawPaths = metadata.paths;
  const paths = Array.isArray(rawPaths)
    ? rawPaths.filter((path): path is string => typeof path === 'string')
    : [];
  return {
    projectId: row.projectId,
    iterationId: row.iterationId,
    lifecycleRecordId: row.id,
    type: row.kind,
    status: repositoryOperationStatus(row.status),
    mutating: repositoryOperationIsMutating(row.kind),
    repositoryUrl: row.repositoryUrl,
    branchName: metadataString('branchName', 'branch')
      ?? (row.kind === 'branch_created' ? row.externalId : null),
    paths,
    expectedBaseRevision: metadataString('expectedBaseRevision', 'baseRevision'),
    resultingRevision: metadataString('resultingRevision', 'revision', 'commitSha'),
    externalId: row.externalId,
    summary: row.summary,
    metadata: { ...metadata, source: 'repository_lifecycle_records' },
    correlationId: row.operationKey,
    operationKey: sourceOperationKey('repository_lifecycle_records', row.id),
    createdAt: row.createdAt,
    startedAt: row.createdAt,
    completedAt: row.status === 'pending' ? null : row.createdAt,
  };
}

export class ProjectStore {
  private readonly pool: Pool;
  private readonly database: NodePgDatabase<typeof schema>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.database = drizzle(this.pool, { schema });
  }

  async migrate(migrationsFolder = defaultMigrationsFolder) {
    await migrate(this.database, { migrationsFolder });
  }

  async artifactContent(projectId: string, artifactId: string, version?: number): Promise<{
    content: string;
    version: number;
    mimeType: string;
  } | undefined> {
    const [artifact] = await this.database.select({
      content: schema.artifacts.content,
      version: schema.artifacts.version,
      mimeType: schema.artifacts.mimeType,
    }).from(schema.artifacts).where(and(
      eq(schema.artifacts.projectId, projectId),
      eq(schema.artifacts.id, artifactId),
      ...(version === undefined ? [] : [eq(schema.artifacts.version, version)]),
    )).limit(1);
    return artifact;
  }

  async create(brief: ProjectBrief): Promise<Project> {
    const row = await this.database.transaction(async (transaction) => {
      const [project] = await transaction.insert(schema.projects).values(brief).returning();
      const [iteration] = await transaction.insert(schema.iterations).values({
        projectId: project.id,
        number: 1,
        objective: 'Turn the initial intent into an approved, testable first increment.',
      }).returning();
      const createdAgents = await transaction.insert(schema.agents).values(organismAgentRoles.map((role) => ({
        projectId: project.id,
        role,
        workflowId: `project/${project.id}/agent/${role}`,
        lifecycleStatus: 'active' as const,
      }))).returning();
      await transaction.insert(schema.agentRuntimeStates).values(createdAgents.map((agent) => ({
        projectId: project.id,
        iterationId: iteration.id,
        agentId: agent.id,
        state: 'observing' as const,
        stateVersion: 0,
        activityType: 'project_observation',
        activitySummary: 'Observing the project for relevant changes.',
        correlationId: `project:${project.id}:bootstrap`,
        operationKey: `${agent.workflowId}:state:0`,
      })));
      const intentContent = this.intentArtifact(brief);
      const [intentArtifact] = await transaction.insert(schema.artifacts).values({
        projectId: project.id,
        iterationId: iteration.id,
        type: 'project-intent',
        name: 'Project intent',
        content: intentContent,
        mimeType: 'text/markdown',
        producedBy: 'manager',
      }).returning();
      const manager = createdAgents.find((agent) => agent.role === 'manager');
      await transaction.insert(schema.artifactVersions).values({
        projectId: project.id,
        iterationId: iteration.id,
        artifactId: intentArtifact.id,
        producedByAgentId: manager?.id ?? null,
        version: intentArtifact.version,
        status: intentArtifact.status,
        content: intentArtifact.content,
        mimeType: intentArtifact.mimeType,
        contentHash: `sha256:${createHash('sha256').update(intentContent).digest('hex')}`,
        metadata: { source: 'project_artifacts', producedBy: 'manager' },
        operationKey: sourceOperationKey('project_artifacts', intentArtifact.id),
        createdAt: intentArtifact.createdAt,
      });
      await transaction.insert(schema.projectEvents).values({
        projectId: project.id,
        iterationNumber: 1,
        kind: 'project',
        title: 'Project studio opened',
        description: 'The project intent was recorded and the first delivery iteration was created.',
        agentRole: 'manager',
      });
      return project;
    });
    return this.toContract(row);
  }

  async find(id: string): Promise<Project | undefined> {
    const [row] = await this.database.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
    return row ? this.toContract(row) : undefined;
  }

  async list(): Promise<ProjectSummary[]> {
    const rows = await this.database.select().from(schema.projects).orderBy(desc(schema.projects.updatedAt));
    return Promise.all(rows.map(async (row) => {
      const [latestEvent] = await this.database.select().from(schema.projectEvents)
        .where(eq(schema.projectEvents.projectId, row.id)).orderBy(desc(schema.projectEvents.createdAt)).limit(1);
      const [{ value: artifactCount }] = await this.database.select({ value: count() }).from(schema.artifacts)
        .where(eq(schema.artifacts.projectId, row.id));
      return {
        ...this.toContract(row),
        latestEvent: latestEvent ? this.toEvent(latestEvent) : null,
        artifactCount,
      };
    }));
  }

  async detail(id: string): Promise<ProjectDetail | undefined> {
    const project = await this.find(id);
    if (!project) return undefined;
    const [
      iterationRows,
      eventRows,
      artifactRows,
      mediaRows,
      questions,
      agentComments,
      artifactFeedback,
      iterationReviews,
      agentRuntimeSnapshots,
      agentMessages,
      iterationReviewProposals,
      agentRows,
      agentGoalRows,
      agentActionPlanRows,
      agentActionRows,
      agentObligationRows,
      artifactVersionRows,
      findingRows,
      modelInvocationRows,
      repositoryOperationRows,
    ] = await Promise.all([
      this.database.select().from(schema.iterations).where(eq(schema.iterations.projectId, id)).orderBy(desc(schema.iterations.number)),
      this.database.select().from(schema.projectEvents).where(eq(schema.projectEvents.projectId, id)).orderBy(desc(schema.projectEvents.createdAt)),
      this.database.select().from(schema.artifacts).where(eq(schema.artifacts.projectId, id)).orderBy(desc(schema.artifacts.createdAt)),
      this.database.select().from(schema.projectMedia).where(eq(schema.projectMedia.projectId, id)).orderBy(desc(schema.projectMedia.createdAt)),
      this.listAgentQuestions(id),
      this.listAgentComments(id),
      this.listArtifactFeedback(id),
      this.listIterationReviews(id),
      this.listAgentRuntimeSnapshots(id),
      this.listAgentMessages(id),
      this.listIterationReviewProposals(id),
      this.database.select().from(schema.agents).where(eq(schema.agents.projectId, id)),
      this.database.select().from(schema.agentGoals).where(eq(schema.agentGoals.projectId, id)).orderBy(desc(schema.agentGoals.updatedAt)),
      this.database.select().from(schema.agentActionPlans).where(eq(schema.agentActionPlans.projectId, id)).orderBy(desc(schema.agentActionPlans.updatedAt)),
      this.database.select().from(schema.agentActions).where(eq(schema.agentActions.projectId, id)).orderBy(desc(schema.agentActions.updatedAt)),
      this.database.select().from(schema.agentObligations).where(eq(schema.agentObligations.projectId, id)).orderBy(desc(schema.agentObligations.updatedAt)),
      this.database.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.projectId, id)).orderBy(desc(schema.artifactVersions.createdAt)),
      this.database.select().from(schema.findings).where(eq(schema.findings.projectId, id)).orderBy(desc(schema.findings.updatedAt)),
      this.database.select().from(schema.modelInvocations).where(eq(schema.modelInvocations.projectId, id)).orderBy(desc(schema.modelInvocations.createdAt)),
      this.database.select().from(schema.repositoryOperations).where(eq(schema.repositoryOperations.projectId, id)).orderBy(desc(schema.repositoryOperations.createdAt)),
    ]);
    const roleByAgentId = new Map(agentRows.map((agent) => [agent.id, agent.role]));
    const artifactById = new Map(artifactRows.map((artifact) => [artifact.id, artifact]));
    return {
      project,
      iterations: iterationRows.map((row) => this.toIteration(row)),
      events: eventRows.map((row) => this.toEvent(row)),
      artifacts: artifactRows.map((row) => this.toArtifact(row)),
      media: mediaRows.map((row) => this.toMedia(row)),
      questions,
      agentComments,
      artifactFeedback,
      iterationReviews,
      agentRuntimeSnapshots,
      agentMessages,
      iterationReviewProposals,
      agentGoals: agentGoalRows.map((row) => this.toAgentGoal(row, roleByAgentId.get(row.agentId)!)),
      agentActionPlans: agentActionPlanRows.map((row) => this.toAgentActionPlan(row, roleByAgentId.get(row.agentId)!)),
      agentActions: agentActionRows.map((row) => this.toAgentAction(row, roleByAgentId.get(row.agentId)!)),
      agentObligations: agentObligationRows.map((row) => this.toAgentObligation(row, roleByAgentId.get(row.ownerAgentId)!)),
      artifactVersions: artifactVersionRows.map((row) => {
        const artifact = artifactById.get(row.artifactId);
        return this.toArtifactVersion(
          row,
          artifact?.type ?? 'unknown',
          artifact?.name ?? row.artifactId,
          row.producedByAgentId ? roleByAgentId.get(row.producedByAgentId) ?? null : null,
        );
      }),
      findings: findingRows.map((row) => this.toFinding(
        row,
        row.raisedByAgentId ? roleByAgentId.get(row.raisedByAgentId) ?? null : null,
        row.ownerAgentId ? roleByAgentId.get(row.ownerAgentId) ?? null : null,
      )),
      modelInvocations: modelInvocationRows.map((row) => this.toModelInvocation(
        row,
        row.agentId ? roleByAgentId.get(row.agentId) ?? null : null,
      )),
      repositoryOperations: repositoryOperationRows.map((row) => this.toRepositoryOperation(
        row,
        row.agentId ? roleByAgentId.get(row.agentId) ?? null : null,
      )),
    };
  }

  async ensureAgent(projectId: string, role: AgentRole) {
    const workflowId = `project/${projectId}/agent/${role}`;
    const [agent] = await this.database.insert(schema.agents).values({
      projectId,
      role,
      workflowId,
      lifecycleStatus: 'active',
    }).onConflictDoUpdate({
      target: [schema.agents.projectId, schema.agents.role],
      set: { workflowId, lifecycleStatus: 'active', updatedAt: new Date() },
    }).returning();
    return agent;
  }

  async recordAgentRuntimeState(input: RecordAgentRuntimeStateInput): Promise<AgentRuntimeSnapshot> {
    const agent = await this.ensureAgent(input.projectId, input.role);
    const [existing] = await this.database.select().from(schema.agentRuntimeStates).where(and(
      eq(schema.agentRuntimeStates.projectId, input.projectId),
      eq(schema.agentRuntimeStates.operationKey, input.operationKey),
    )).limit(1);
    if (existing) return this.toAgentRuntimeSnapshot(input.role, existing);

    const enteredAt = input.enteredAt ? new Date(input.enteredAt) : new Date();
    if (Number.isNaN(enteredAt.getTime())) throw new Error('Agent runtime enteredAt must be a valid timestamp.');
    const row = await this.database.transaction(async (transaction) => {
      await transaction.update(schema.agentRuntimeStates).set({ exitedAt: enteredAt }).where(and(
        eq(schema.agentRuntimeStates.agentId, agent.id),
        isNull(schema.agentRuntimeStates.exitedAt),
      ));
      const [created] = await transaction.insert(schema.agentRuntimeStates).values({
        projectId: input.projectId,
        iterationId: input.iterationId ?? null,
        agentId: agent.id,
        state: input.state,
        stateVersion: input.stateVersion,
        activityType: input.activity?.type ?? null,
        activitySummary: input.activity?.summary ?? null,
        waitingReason: input.waitingReason ?? null,
        blockerReferences: input.blockerReferences ?? [],
        modelProvider: input.modelProvider ?? null,
        model: input.model ?? null,
        workflowRunId: input.workflowRunId ?? null,
        correlationId: input.correlationId ?? null,
        operationKey: input.operationKey,
        enteredAt,
      }).returning();
      return created;
    });
    return this.toAgentRuntimeSnapshot(input.role, row);
  }

  async listAgentRuntimeSnapshots(projectId: string): Promise<AgentRuntimeSnapshot[]> {
    const rows = await this.database.select({
      role: schema.agents.role,
      state: schema.agentRuntimeStates,
    }).from(schema.agentRuntimeStates)
      .innerJoin(schema.agents, eq(schema.agentRuntimeStates.agentId, schema.agents.id))
      .where(and(
        eq(schema.agentRuntimeStates.projectId, projectId),
        isNull(schema.agentRuntimeStates.exitedAt),
      ));
    return rows.map((row) => this.toAgentRuntimeSnapshot(row.role, row.state));
  }

  async recordAgentOrderLedger(
    projectId: string,
    iterationId: string,
    role: AgentRole,
    order: AgentOrder,
    correlationId: string,
    sourceRevision?: string,
  ): Promise<void> {
    const agent = await this.ensureAgent(projectId, role);
    const priority = order.priority.toLowerCase() as 'low' | 'normal' | 'high' | 'critical';
    const goalOperationKey = `${order.orderId}:goal`;
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.agentGoals).values({
        projectId,
        iterationId,
        agentId: agent.id,
        objective: order.objective,
        status: 'active',
        priority,
        successCriteria: order.acceptanceCriteria.map((criterion) => criterion.description),
        correlationId,
        operationKey: goalOperationKey,
      }).onConflictDoNothing({
        target: [schema.agentGoals.projectId, schema.agentGoals.operationKey],
      });
      const [goal] = await transaction.select().from(schema.agentGoals).where(and(
        eq(schema.agentGoals.projectId, projectId),
        eq(schema.agentGoals.operationKey, goalOperationKey),
      )).limit(1);
      if (!goal) throw new Error(`Goal ledger record ${goalOperationKey} could not be loaded.`);

      const supersededAt = new Date();
      await transaction.update(schema.agentGoals).set({
        status: 'superseded',
        updatedAt: supersededAt,
        completedAt: supersededAt,
      }).where(and(
        eq(schema.agentGoals.projectId, projectId),
        eq(schema.agentGoals.iterationId, iterationId),
        eq(schema.agentGoals.agentId, agent.id),
        inArray(schema.agentGoals.status, ['active', 'blocked']),
        ne(schema.agentGoals.id, goal.id),
      ));
      await transaction.update(schema.agentActionPlans).set({
        status: 'superseded',
        updatedAt: supersededAt,
        completedAt: supersededAt,
      }).where(and(
        eq(schema.agentActionPlans.projectId, projectId),
        eq(schema.agentActionPlans.iterationId, iterationId),
        eq(schema.agentActionPlans.agentId, agent.id),
        inArray(schema.agentActionPlans.status, ['draft', 'active', 'blocked']),
        ne(schema.agentActionPlans.goalId, goal.id),
      ));
      await transaction.update(schema.agentObligations).set({
        status: 'deferred',
        blocking: false,
        disposition: `Superseded by order ${order.orderId}.`,
        updatedAt: supersededAt,
      }).where(and(
        eq(schema.agentObligations.projectId, projectId),
        eq(schema.agentObligations.iterationId, iterationId),
        eq(schema.agentObligations.ownerAgentId, agent.id),
        inArray(schema.agentObligations.status, ['pending', 'ready', 'in_progress', 'blocked', 'failed']),
        ne(schema.agentObligations.goalId, goal.id),
      ));

      await transaction.insert(schema.agentActionPlans).values({
        projectId,
        iterationId,
        agentId: agent.id,
        goalId: goal.id,
        version: 1,
        summary: order.objective,
        rationale: order.rationale ?? null,
        status: 'active',
        sourceRevision: sourceRevision ?? null,
        correlationId,
        operationKey: `${order.orderId}:plan:accepted-order`,
      }).onConflictDoNothing({
        target: [schema.agentActionPlans.projectId, schema.agentActionPlans.operationKey],
      });

      const obligations = [
        ...order.expectedOutputs.filter((output) => output.required).map((output, index) => ({
          operationKey: `${order.orderId}:obligation:output:${index}`,
          type: 'required_output',
          title: `Produce ${output.artifactType}`,
          description: output.description,
          mandatory: true,
          subjectReferences: [output.artifactType],
          dependencyReferences: [] as string[],
        })),
        ...order.requiredEvidence.filter((evidence) => evidence.required).map((evidence, index) => ({
          operationKey: `${order.orderId}:obligation:evidence:${index}`,
          type: 'required_evidence',
          title: `Provide ${evidence.evidenceType}`,
          description: evidence.description,
          mandatory: true,
          subjectReferences: evidence.subjectRefs,
          dependencyReferences: [] as string[],
        })),
        ...order.acceptanceCriteria.filter((criterion) => criterion.mandatory).map((criterion, index) => ({
          operationKey: `${order.orderId}:obligation:criterion:${index}`,
          type: 'acceptance_criterion',
          title: criterion.criterionId,
          description: criterion.description,
          mandatory: true,
          subjectReferences: criterion.requirementRefs,
          dependencyReferences: order.dependencies.filter((dependency) => dependency.required).map((dependency) => dependency.refId),
        })),
      ];
      if (obligations.length > 0) {
        await transaction.insert(schema.agentObligations).values(obligations.map((obligation) => ({
          projectId,
          iterationId,
          ownerAgentId: agent.id,
          goalId: goal.id,
          type: obligation.type,
          title: obligation.title,
          description: obligation.description,
          status: 'in_progress' as const,
          priority,
          mandatory: obligation.mandatory,
          blocking: obligation.mandatory,
          subjectReferences: obligation.subjectReferences,
          dependencyReferences: obligation.dependencyReferences,
          sourceRevision: sourceRevision ?? null,
          correlationId,
          operationKey: obligation.operationKey,
        }))).onConflictDoNothing({
          target: [schema.agentObligations.projectId, schema.agentObligations.operationKey],
        });
      }
    });
  }

  async recordAgentExecutionLedger(
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
    await this.recordAgentOrderLedger(projectId, iterationId, role, order, correlationId, sourceRevision);
    const agent = await this.ensureAgent(projectId, role);
    const findingOwnerIds = new Map<AgentRole, string>([[role, agent.id]]);
    for (const ownerRole of new Set((trace?.findings ?? []).map((finding) => finding.ownerRole))) {
      if (findingOwnerIds.has(ownerRole)) continue;
      findingOwnerIds.set(ownerRole, (await this.ensureAgent(projectId, ownerRole)).id);
    }
    const now = new Date();
    const goalStatus = status === 'completed' ? 'satisfied' : status === 'waiting_for_human' ? 'active' : 'blocked';
    const planStatus = status === 'completed' ? 'completed' : status === 'waiting_for_human' ? 'active' : 'blocked';
    const obligationStatus = status === 'completed' ? 'satisfied' : status === 'waiting_for_human' ? 'in_progress' : 'blocked';
    await this.database.transaction(async (transaction) => {
      const [goal] = await transaction.select().from(schema.agentGoals).where(and(
        eq(schema.agentGoals.projectId, projectId),
        eq(schema.agentGoals.operationKey, `${order.orderId}:goal`),
      )).limit(1);
      if (!goal) throw new Error(`Goal ledger record for ${order.orderId} was not found.`);
      if (status === 'completed') {
        await transaction.update(schema.findings).set({
          status: 'resolved',
          disposition: 'remediate_current',
          updatedAt: now,
          resolvedAt: now,
        }).where(and(
          eq(schema.findings.projectId, projectId),
          eq(schema.findings.iterationId, iterationId),
          eq(schema.findings.ownerAgentId, agent.id),
          eq(schema.findings.correlationId, correlationId),
          inArray(schema.findings.category, ['execution_failure', 'plan_validation']),
          inArray(schema.findings.status, ['open', 'acknowledged', 'remediating']),
        ));
      }
      await transaction.update(schema.agentGoals).set({
        status: goalStatus,
        updatedAt: now,
        completedAt: status === 'completed' ? now : null,
      }).where(eq(schema.agentGoals.id, goal.id));
      await transaction.update(schema.agentActionPlans).set({
        status: planStatus,
        updatedAt: now,
        completedAt: status === 'completed' ? now : null,
      }).where(and(
        eq(schema.agentActionPlans.projectId, projectId),
        eq(schema.agentActionPlans.operationKey, `${order.orderId}:plan:accepted-order`),
      ));
      await transaction.update(schema.agentObligations).set({
        status: obligationStatus,
        satisfactionEvidence: status === 'completed' ? artifactIds : [],
        sourceRevision: sourceRevision ?? null,
        disposition: status === 'budget_exhausted' ? 'Execution budget exhausted.'
          : status === 'blocked' ? failureReason ?? trace?.terminalReason ?? 'The role order is blocked.'
            : status === 'waiting_for_human' ? 'Waiting for a recorded human decision.' : null,
        updatedAt: now,
        satisfiedAt: status === 'completed' ? now : null,
      }).where(and(
        eq(schema.agentObligations.projectId, projectId),
        eq(schema.agentObligations.goalId, goal.id),
      ));

      const executionIdentity = trace?.executionId ?? `${correlationId}:${status}`;
      const executionKey = createHash('sha256').update(executionIdentity).digest('hex').slice(0, 24);
      const [{ value: highestPlanVersion }] = await transaction.select({
        value: max(schema.agentActionPlans.version),
      }).from(schema.agentActionPlans).where(eq(schema.agentActionPlans.goalId, goal.id));
      let nextPlanVersion = (highestPlanVersion ?? 0) + 1;
      const actionLedgerIds = new Map<string, string>();

      for (const tracePlan of trace?.plans ?? []) {
        const planOperationKey = `${order.orderId}:execution:${executionKey}:trace-plan:${tracePlan.round}:${tracePlan.repairAttempt}`;
        const [existingPlan] = await transaction.select().from(schema.agentActionPlans).where(and(
          eq(schema.agentActionPlans.projectId, projectId),
          eq(schema.agentActionPlans.operationKey, planOperationKey),
        )).limit(1);
        const desiredPlanStatus = tracePlan.accepted ? planStatus : 'superseded';
        const [plan] = existingPlan
          ? await transaction.update(schema.agentActionPlans).set({
            status: desiredPlanStatus,
            sourceRevision: sourceRevision ?? null,
            correlationId,
            updatedAt: now,
            completedAt: tracePlan.accepted && status === 'completed' ? now : null,
          }).where(eq(schema.agentActionPlans.id, existingPlan.id)).returning()
          : await transaction.insert(schema.agentActionPlans).values({
            projectId,
            iterationId,
            agentId: agent.id,
            goalId: goal.id,
            version: nextPlanVersion++,
            summary: tracePlan.goalAssessment || `Execution plan round ${tracePlan.round}`,
            rationale: tracePlan.validationIssues.length > 0 ? tracePlan.validationIssues.join('\n') : null,
            status: desiredPlanStatus,
            sourceRevision: sourceRevision ?? null,
            correlationId,
            operationKey: planOperationKey,
            createdAt: now,
            updatedAt: now,
            completedAt: tracePlan.accepted && status === 'completed' ? now : null,
          }).returning();
        if (!plan) throw new Error(`Action plan ledger record ${planOperationKey} could not be loaded.`);

        for (const [actionIndex, action] of tracePlan.actions.entries()) {
          const observation = trace?.observations.find((candidate) =>
            candidate.round === tracePlan.round && candidate.actionId === action.id);
          const actionStatus: (typeof schema.agentActionStatuses)[number] = observation?.status === 'succeeded' ? 'completed'
            : observation?.status === 'failed' ? 'failed'
              : observation?.status === 'skipped' ? 'cancelled'
                : tracePlan.accepted ? 'pending' : 'superseded';
          const actionOperationKey = `${planOperationKey}:action:${action.id}`;
          const actionValues = {
            projectId,
            iterationId,
            agentId: agent.id,
            planId: plan.id,
            position: actionIndex,
            kind: `${action.activity}@${action.activityVersion}`,
            summary: action.reason,
            status: actionStatus,
            blocking: actionStatus === 'failed',
            dependencyActionIds: action.dependsOn,
            input: { activity: action.activity, activityVersion: action.activityVersion },
            output: observation?.result ?? null,
            error: observation?.error?.message ?? null,
            correlationId,
            operationKey: actionOperationKey,
            updatedAt: now,
            startedAt: observation ? now : null,
            completedAt: observation ? now : null,
          } satisfies typeof schema.agentActions.$inferInsert;
          const [existingActionAtPosition] = await transaction.select().from(schema.agentActions).where(and(
            eq(schema.agentActions.planId, plan.id),
            eq(schema.agentActions.position, actionIndex),
          )).limit(1);
          const [actionRow] = existingActionAtPosition
            ? await transaction.update(schema.agentActions).set({
              kind: actionValues.kind,
              summary: actionValues.summary,
              status: actionValues.status,
              blocking: actionValues.blocking,
              dependencyActionIds: actionValues.dependencyActionIds,
              input: actionValues.input,
              output: actionValues.output,
              error: actionValues.error,
              correlationId: actionValues.correlationId,
              operationKey: actionValues.operationKey,
              updatedAt: now,
              startedAt: actionValues.startedAt,
              completedAt: actionValues.completedAt,
            }).where(eq(schema.agentActions.id, existingActionAtPosition.id)).returning()
            : await transaction.insert(schema.agentActions).values({
              ...actionValues,
              createdAt: now,
            }).returning();
          if (actionRow) actionLedgerIds.set(action.id, actionRow.id);
          if (observation?.status === 'failed') {
            const findingStatus: (typeof schema.findingStatuses)[number] = status === 'completed' ? 'resolved' : 'open';
            const findingValues = {
              projectId,
              iterationId,
              raisedByAgentId: agent.id,
              ownerAgentId: agent.id,
              actionId: actionRow?.id ?? null,
              category: 'execution_failure',
              title: `${action.activity} failed`,
              description: observation.error?.message ?? observation.summary,
              severity: 'high' as const,
              status: findingStatus,
              disposition: 'remediate_current' as const,
              subjectReferences: [action.activity],
              evidenceReferences: [observation.operationKey],
              sourceRevision: sourceRevision ?? null,
              correlationId,
              operationKey: `${actionOperationKey}:finding`,
              createdAt: now,
              updatedAt: now,
              resolvedAt: status === 'completed' ? now : null,
            } satisfies typeof schema.findings.$inferInsert;
            await transaction.insert(schema.findings).values(findingValues).onConflictDoUpdate({
              target: [schema.findings.projectId, schema.findings.operationKey],
              set: {
                status: findingValues.status,
                disposition: findingValues.disposition,
                sourceRevision: findingValues.sourceRevision,
                correlationId: findingValues.correlationId,
                updatedAt: now,
                resolvedAt: findingValues.resolvedAt,
              },
            });
          }
        }

        for (const [issueIndex, issue] of tracePlan.validationIssues.entries()) {
          const validationFindingStatus: (typeof schema.findingStatuses)[number] = tracePlan.accepted || status === 'completed'
            ? 'resolved'
            : 'open';
          const validationFindingValues = {
            projectId,
            iterationId,
            raisedByAgentId: agent.id,
            ownerAgentId: agent.id,
            category: 'plan_validation',
            title: `Plan validation issue ${issueIndex + 1}`,
            description: issue,
            severity: 'medium' as const,
            status: validationFindingStatus,
            disposition: 'remediate_current' as const,
            subjectReferences: [planOperationKey],
            evidenceReferences: [],
            sourceRevision: sourceRevision ?? null,
            correlationId,
            operationKey: `${planOperationKey}:validation-finding:${issueIndex}`,
            createdAt: now,
            updatedAt: now,
            resolvedAt: tracePlan.accepted || status === 'completed' ? now : null,
          } satisfies typeof schema.findings.$inferInsert;
          await transaction.insert(schema.findings).values(validationFindingValues).onConflictDoUpdate({
            target: [schema.findings.projectId, schema.findings.operationKey],
            set: {
              status: validationFindingValues.status,
              sourceRevision: validationFindingValues.sourceRevision,
              correlationId: validationFindingValues.correlationId,
              updatedAt: now,
              resolvedAt: validationFindingValues.resolvedAt,
            },
          });
        }
      }

      const traceInvocations = trace?.invocations ?? [];
      const traceExecutionId = trace?.executionId;
      if (traceExecutionId && traceInvocations.length) {
        await transaction.insert(schema.modelInvocations).values(traceInvocations.map((invocation, invocationIndex) => {
          const inputTokens = Math.trunc(invocation.usage?.promptTokens ?? 0);
          const outputTokens = Math.trunc(invocation.usage?.completionTokens ?? 0);
          return {
            projectId,
            iterationId,
            agentId: agent.id,
            provider: invocation.provider ?? 'ollama',
            model: invocation.model,
            purpose: invocation.purpose,
            status: 'succeeded' as const,
            externalRequestId: invocation.requestId ?? null,
            inputTokens,
            outputTokens,
            totalTokens: Math.trunc(invocation.usage?.totalTokens ?? inputTokens + outputTokens),
            costUsd: invocation.usage?.cost ?? 0,
            requestMetadata: {
              executionId: traceExecutionId,
              invocationIndex,
              round: invocation.round,
              providerReported: invocation.provider !== undefined,
              usageReported: invocation.usage !== undefined,
            },
            responseMetadata: { dynamicTerminalStatus: status },
            correlationId,
            operationKey: dynamicExecutionModelInvocationOperationKey(traceExecutionId, invocationIndex),
            createdAt: now,
            startedAt: now,
            completedAt: now,
          };
        })).onConflictDoUpdate({
          target: [schema.modelInvocations.projectId, schema.modelInvocations.operationKey],
          set: {
            responseMetadata: { dynamicTerminalStatus: status },
            correlationId,
          },
        });
      }

      for (const finding of trace?.findings ?? []) {
        const resolved = finding.status === 'resolved';
        const findingValues = {
          projectId,
          iterationId,
          raisedByAgentId: agent.id,
          ownerAgentId: findingOwnerIds.get(finding.ownerRole) ?? agent.id,
          actionId: actionLedgerIds.get(finding.raisedByActionId) ?? null,
          category: finding.category,
          title: `Quality review finding for candidate ${finding.candidateVersion}`,
          description: finding.summary,
          severity: finding.severity,
          status: finding.status,
          disposition: finding.disposition,
          subjectReferences: [`candidate:${finding.candidateVersion}`],
          evidenceReferences: finding.evidenceRefs,
          sourceRevision: sourceRevision ?? null,
          correlationId,
          operationKey: `${order.orderId}:execution:${executionKey}:domain-finding:${finding.findingId}`,
          createdAt: now,
          updatedAt: now,
          resolvedAt: resolved ? now : null,
        } satisfies typeof schema.findings.$inferInsert;
        await transaction.insert(schema.findings).values(findingValues).onConflictDoUpdate({
          target: [schema.findings.projectId, schema.findings.operationKey],
          set: {
            ownerAgentId: findingValues.ownerAgentId,
            actionId: findingValues.actionId,
            category: findingValues.category,
            title: findingValues.title,
            description: findingValues.description,
            severity: findingValues.severity,
            status: findingValues.status,
            disposition: findingValues.disposition,
            subjectReferences: findingValues.subjectReferences,
            evidenceReferences: findingValues.evidenceReferences,
            sourceRevision: findingValues.sourceRevision,
            correlationId: findingValues.correlationId,
            updatedAt: now,
            resolvedAt: findingValues.resolvedAt,
          },
        });
      }
    });
  }

  async recordAgentMessage(message: AgentMessage): Promise<AgentInteraction> {
    const [existing] = await this.database.select().from(schema.agentMessages).where(and(
      eq(schema.agentMessages.projectId, message.projectId),
      eq(schema.agentMessages.idempotencyKey, message.idempotencyKey),
    )).limit(1);
    if (existing) return this.toAgentInteraction(existing, messagePayloadIterationNumber(message.payload) ?? 1);

    const payload = safeMessagePayload(message.payload);
    const senderRole: AgentRole | 'human' = payload.authoredBy === 'human' ? 'human' : message.sender.role;
    const sender = senderRole === 'human' ? undefined : await this.ensureAgent(message.projectId, senderRole);
    const now = new Date(message.createdAt);
    if (Number.isNaN(now.getTime())) throw new Error('Agent message createdAt must be a valid timestamp.');
    const recipientRoles = [...new Set(message.recipients.map((recipient) => recipient.role))];
    const summary = messagePayloadSummary(message.payload) ?? message.name;
    const messageType = protocolMessageType(message);
    const row = await this.database.transaction(async (transaction) => {
      const [causation] = message.causationId
        ? await transaction.select().from(schema.agentMessages).where(and(
          eq(schema.agentMessages.projectId, message.projectId),
          eq(schema.agentMessages.protocolMessageId, message.causationId),
        )).limit(1)
        : [];
      if (message.causationId && !causation) {
        throw new Error(`Message ${message.messageId} references unknown causation ${message.causationId}.`);
      }
      const responseDepth = causation ? causation.responseDepth + 1 : 0;
      if (messageType === 'finding') {
        const cooldownKey = `${message.projectId}:${message.correlationId}:${senderRole}:${message.name}:${summary}`;
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${cooldownKey}))`);
        const [recentDuplicate] = await transaction.select({ createdAt: schema.agentMessages.createdAt })
          .from(schema.agentMessages)
          .where(and(
            eq(schema.agentMessages.projectId, message.projectId),
            eq(schema.agentMessages.correlationId, message.correlationId),
            eq(schema.agentMessages.senderRole, senderRole),
            eq(schema.agentMessages.type, 'finding'),
            eq(schema.agentMessages.name, message.name),
            eq(schema.agentMessages.summary, summary),
          ))
          .orderBy(desc(schema.agentMessages.createdAt))
          .limit(1);
        const elapsedSinceDuplicate = recentDuplicate
          ? now.getTime() - recentDuplicate.createdAt.getTime()
          : undefined;
        if (elapsedSinceDuplicate !== undefined
          && elapsedSinceDuplicate >= 0
          && elapsedSinceDuplicate < FINDING_REPEAT_COOLDOWN_MS) {
          throw new Error(`Finding ${message.name} is inside the ${FINDING_REPEAT_COOLDOWN_MS / 1_000}-second repeat cooldown.`);
        }
      }
      const [thread] = await transaction.insert(schema.messageThreads).values({
        projectId: message.projectId,
        iterationId: message.iterationId ?? null,
        correlationId: message.correlationId,
        topic: message.name,
        status: 'open',
        responseCount: 1,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
      }).onConflictDoUpdate({
        target: [schema.messageThreads.projectId, schema.messageThreads.correlationId],
        set: {
          updatedAt: now,
          lastMessageAt: now,
          status: 'open',
          responseCount: sql`${schema.messageThreads.responseCount} + 1`,
        },
      }).returning();
      if (responseDepth > thread.maxResponseDepth) {
        throw new Error(`Message ${message.messageId} exceeds topic response depth ${thread.maxResponseDepth}.`);
      }
      if (thread.responseCount > thread.maxResponseDepth * 8) {
        throw new Error(`Topic ${message.correlationId} exhausted its ${thread.maxResponseDepth * 8}-message response budget.`);
      }
      const [created] = await transaction.insert(schema.agentMessages).values({
        protocolMessageId: message.messageId,
        projectId: message.projectId,
        iterationId: message.iterationId ?? null,
        threadId: thread.id,
        senderAgentId: sender?.id ?? null,
        senderRole,
        recipientRoles,
        type: messageType,
        name: message.name,
        summary,
        status: 'pending',
        priority: message.priority.toLowerCase() as 'low' | 'normal' | 'high' | 'critical',
        correlationId: message.correlationId,
        causationMessageId: causation?.id ?? null,
        responseDepth,
        idempotencyKey: message.idempotencyKey,
        requiresAcknowledgement: message.acknowledgementRequired,
        deliveryStates: Object.fromEntries(recipientRoles.map((role) => [role, 'pending'])),
        payload,
        artifactReferences: message.artifactRefs?.map((artifact) => artifact.artifactId) ?? [],
        createdAt: now,
        availableAt: now,
        deliveredAt: null,
      }).returning();
      return created;
    });
    return this.toAgentInteraction(row, messagePayloadIterationNumber(message.payload) ?? 1);
  }

  async listAgentMessages(projectId: string): Promise<AgentInteraction[]> {
    const [messages, iterations] = await Promise.all([
      this.database.select().from(schema.agentMessages)
        .where(eq(schema.agentMessages.projectId, projectId))
        .orderBy(desc(schema.agentMessages.createdAt)),
      this.database.select().from(schema.iterations).where(eq(schema.iterations.projectId, projectId)),
    ]);
    const iterationById = new Map(iterations.map((iteration) => [iteration.id, iteration.number]));
    return messages.map((message) => this.toAgentInteraction(
      message,
      message.iterationId ? iterationById.get(message.iterationId) ?? 1 : 1,
    ));
  }

  async transitionAgentMessage(
    projectId: string,
    idempotencyKey: string,
    transition: AgentMessageTransition,
    recipientRole?: AgentRole | 'human' | 'system',
  ): Promise<AgentInteraction | undefined> {
    const row = await this.database.transaction(async (transaction) => {
      const [existing] = await transaction.select().from(schema.agentMessages).where(and(
        eq(schema.agentMessages.projectId, projectId),
        eq(schema.agentMessages.idempotencyKey, idempotencyKey),
      )).limit(1).for('update');
      if (!existing) return undefined;
      if (recipientRole && !existing.recipientRoles.includes(recipientRole)) {
        throw new Error(`Message ${idempotencyKey} is not addressed to ${recipientRole}.`);
      }

      const rank: Record<'pending' | AgentMessageTransition, number> = {
        pending: 0,
        delivered: 1,
        acknowledged: 2,
        completed: 3,
        failed: 3,
      };
      if (existing.status === 'superseded'
        || existing.status === 'completed'
        || existing.status === 'failed') return existing;

      const now = new Date();
      const roles = recipientRole ? [recipientRole] : existing.recipientRoles;
      const deliveryStates = { ...existing.deliveryStates };
      let deliveryStateChanged = false;
      for (const role of roles) {
        const current = deliveryStates[role];
        const currentRank = typeof current === 'string' && current in rank
          ? rank[current as keyof typeof rank]
          : -1;
        if (rank[transition] < currentRank || current === 'completed' || current === 'failed') continue;
        deliveryStates[role] = transition;
        deliveryStateChanged ||= current !== transition;
      }
      const recipientStates = existing.recipientRoles.map((role) => {
        const state = deliveryStates[role];
        return typeof state === 'string' && state in rank
          ? state as 'pending' | AgentMessageTransition
          : 'pending';
      });
      const everyRecipientTerminal = recipientStates.every((state) => state === 'completed' || state === 'failed');
      const status: Exclude<(typeof schema.agentMessageStatuses)[number], 'superseded'> = everyRecipientTerminal
        ? recipientStates.some((state) => state === 'failed') ? 'failed' : 'completed'
        : recipientStates.some((state) => state === 'pending') ? 'pending'
          : recipientStates.some((state) => state === 'delivered') ? 'delivered'
            : 'acknowledged';
      if (!deliveryStateChanged && status === existing.status) return existing;
      const [updated] = await transaction.update(schema.agentMessages).set({
        status,
        deliveryStates,
        deliveredAt: recipientStates.some((state) => ['delivered', 'acknowledged', 'completed'].includes(state))
          ? existing.deliveredAt ?? now
          : existing.deliveredAt,
        acknowledgedAt: recipientStates.some((state) => state === 'acknowledged' || state === 'completed')
          ? existing.acknowledgedAt ?? now
          : existing.acknowledgedAt,
        completedAt: status === 'completed' || status === 'failed'
          ? existing.completedAt ?? now
          : existing.completedAt,
      }).where(eq(schema.agentMessages.id, existing.id)).returning();
      return updated;
    });
    if (!row) return undefined;
    const [iteration] = row.iterationId
      ? await this.database.select({ number: schema.iterations.number }).from(schema.iterations)
        .where(eq(schema.iterations.id, row.iterationId)).limit(1)
      : [];
    return this.toAgentInteraction(row, iteration?.number ?? 1);
  }

  async recordIterationReviewProposal(input: RecordIterationReviewProposalInput): Promise<IterationReviewProposal> {
    const manager = await this.ensureAgent(input.projectId, 'manager');
    const [existing] = await this.database.select().from(schema.iterationReviewProposals).where(and(
      eq(schema.iterationReviewProposals.projectId, input.projectId),
      eq(schema.iterationReviewProposals.operationKey, input.operationKey),
    )).limit(1);
    if (existing) return this.toIterationReviewProposal(existing, input.iterationNumber);
    const [{ value: currentVersion }] = await this.database.select({ value: max(schema.iterationReviewProposals.proposalVersion) })
      .from(schema.iterationReviewProposals)
      .where(eq(schema.iterationReviewProposals.iterationId, input.iterationId));
    const now = new Date();
    await this.database.update(schema.iterationReviewProposals).set({
      status: 'superseded',
      resolvedAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.iterationReviewProposals.iterationId, input.iterationId),
      inArray(schema.iterationReviewProposals.status, ['draft', 'proposed', 'gate_blocked']),
    ));
    const [row] = await this.database.insert(schema.iterationReviewProposals).values({
      projectId: input.projectId,
      iterationId: input.iterationId,
      proposedByAgentId: manager.id,
      proposalVersion: (currentVersion ?? 0) + 1,
      status: input.recommendation === 'send_for_human_review' ? 'proposed' : 'draft',
      objectiveStatus: input.objectiveStatus,
      includedRevision: input.includedRevision,
      completedOutcomes: input.completedOutcomes,
      openFindings: input.openFindings,
      agentPositions: input.agentPositions,
      gateStatus: input.gateStatus === 'blocked' ? 'block' : 'pass',
      gateRationale: input.gateRationale,
      managerRationale: input.managerRationale,
      recommendation: input.recommendation,
      knownLimitations: input.knownLimitations,
      budgetSnapshot: input.budgetSnapshot,
      correlationId: input.correlationId,
      operationKey: input.operationKey,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return this.toIterationReviewProposal(row, input.iterationNumber);
  }

  async supersedeIterationReviewProposal(projectId: string, iterationNumber: number): Promise<boolean> {
    const [iteration] = await this.database.select({ id: schema.iterations.id }).from(schema.iterations)
      .where(and(
        eq(schema.iterations.projectId, projectId),
        eq(schema.iterations.number, iterationNumber),
      )).limit(1);
    if (!iteration) return false;
    const now = new Date();
    await this.database.update(schema.iterationReviewProposals).set({
      status: 'superseded',
      resolvedAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.iterationReviewProposals.projectId, projectId),
      eq(schema.iterationReviewProposals.iterationId, iteration.id),
      inArray(schema.iterationReviewProposals.status, ['draft', 'proposed', 'gate_blocked']),
    ));
    // Replays after the first update remain successful for an existing
    // iteration even when there is no longer an active proposal to mutate.
    return true;
  }

  async listIterationReviewProposals(projectId: string): Promise<IterationReviewProposal[]> {
    const [proposals, iterations] = await Promise.all([
      this.database.select().from(schema.iterationReviewProposals)
        .where(eq(schema.iterationReviewProposals.projectId, projectId))
        .orderBy(desc(schema.iterationReviewProposals.createdAt)),
      this.database.select().from(schema.iterations).where(eq(schema.iterations.projectId, projectId)),
    ]);
    const iterationById = new Map(iterations.map((iteration) => [iteration.id, iteration.number]));
    return proposals.map((proposal) => this.toIterationReviewProposal(
      proposal,
      iterationById.get(proposal.iterationId) ?? 1,
    ));
  }

  async iteration(projectId: string, number: number): Promise<ProjectIteration> {
    const [existing] = await this.database.select().from(schema.iterations)
      .where(and(eq(schema.iterations.projectId, projectId), eq(schema.iterations.number, number))).limit(1);
    if (existing) return this.toIteration(existing);
    const [created] = await this.database.insert(schema.iterations).values({
      projectId,
      number,
      objective: `Deliver the next smallest valuable increment for iteration ${number}.`,
    }).returning();
    await this.database.update(schema.projects).set({ currentIteration: number, updatedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    return this.toIteration(created);
  }

  async updateStatus(projectId: string, status: ProjectStatus) {
    await this.database.update(schema.projects).set({ status, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
  }

  async updateIterationStatus(
    projectId: string,
    iterationNumber: number,
    status: ProjectIteration['status'],
  ): Promise<boolean> {
    const [updated] = await this.database.update(schema.iterations).set({
      status,
      completedAt: status === 'completed' ? new Date() : null,
    }).where(and(
      eq(schema.iterations.projectId, projectId),
      eq(schema.iterations.number, iterationNumber),
    )).returning({ id: schema.iterations.id });
    return updated !== undefined;
  }

  async updatePreviewUrl(projectId: string, previewUrl: string | null): Promise<Project> {
    const [row] = await this.database.update(schema.projects).set({
      previewUrl,
      updatedAt: new Date(),
    }).where(eq(schema.projects.id, projectId)).returning();
    return this.toContract(row);
  }

  async connectRepository(projectId: string, repository: { url: string; owner: string; name: string }): Promise<Project> {
    const row = await this.database.transaction(async (transaction) => {
      const [updated] = await transaction.update(schema.projects).set({
        repositoryUrl: repository.url,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        updatedAt: new Date(),
      }).where(eq(schema.projects.id, projectId)).returning();
      const [lifecycle] = await transaction.insert(schema.repositoryLifecycleRecords).values({
        projectId,
        kind: 'repository_connected',
        status: 'completed',
        repositoryUrl: repository.url,
        externalId: `${repository.owner}/${repository.name}`,
        summary: `Connected repository ${repository.owner}/${repository.name}.`,
        metadata: { owner: repository.owner, name: repository.name },
        operationKey: `v1:repository:${projectId}:connected:${repository.owner}/${repository.name}`,
      }).onConflictDoUpdate({
        target: [schema.repositoryLifecycleRecords.projectId, schema.repositoryLifecycleRecords.operationKey],
        set: {
          status: 'completed',
          repositoryUrl: repository.url,
          externalId: `${repository.owner}/${repository.name}`,
          summary: `Connected repository ${repository.owner}/${repository.name}.`,
          metadata: { owner: repository.owner, name: repository.name },
        },
      }).returning();
      const repositoryOperation = repositoryOperationValues(lifecycle);
      await transaction.insert(schema.repositoryOperations).values(repositoryOperation).onConflictDoUpdate({
        target: [schema.repositoryOperations.projectId, schema.repositoryOperations.operationKey],
        set: {
          status: repositoryOperation.status,
          repositoryUrl: repositoryOperation.repositoryUrl,
          externalId: repositoryOperation.externalId,
          summary: repositoryOperation.summary,
          metadata: repositoryOperation.metadata,
          completedAt: repositoryOperation.completedAt,
        },
      });
      return updated;
    });
    return this.toContract(row);
  }

  async setForgejoProjectId(projectId: string, forgejoProjectId: number): Promise<Project> {
    const [row] = await this.database.update(schema.projects).set({
      forgejoProjectId,
      updatedAt: new Date(),
    }).where(eq(schema.projects.id, projectId)).returning();
    return this.toContract(row);
  }

  async recordIterationWorkIssue(input: {
    projectId: string;
    iterationId: string;
    issueNumber: number;
    packageKey?: string | null;
    title: string;
    createdByRole: AgentRole;
    parentIssueNumber?: number | null;
  }): Promise<void> {
    await this.database.insert(schema.iterationWorkIssues).values({
      projectId: input.projectId,
      iterationId: input.iterationId,
      issueNumber: input.issueNumber,
      packageKey: input.packageKey ?? null,
      title: input.title,
      createdByRole: input.createdByRole,
      parentIssueNumber: input.parentIssueNumber ?? null,
    }).onConflictDoNothing({
      target: [schema.iterationWorkIssues.iterationId, schema.iterationWorkIssues.issueNumber],
    });
  }

  async listIterationWorkIssues(iterationId: string): Promise<Array<{
    issueNumber: number;
    packageKey: string | null;
    title: string;
    createdByRole: AgentRole;
    parentIssueNumber: number | null;
  }>> {
    const rows = await this.database.select().from(schema.iterationWorkIssues)
      .where(eq(schema.iterationWorkIssues.iterationId, iterationId))
      .orderBy(schema.iterationWorkIssues.createdAt);
    return rows.map((row) => ({
      issueNumber: row.issueNumber,
      packageKey: row.packageKey,
      title: row.title,
      createdByRole: row.createdByRole,
      parentIssueNumber: row.parentIssueNumber,
    }));
  }

  async updateIterationDelivery(iterationId: string, delivery: {
    issueNumber?: number;
    branchName?: string;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
  }): Promise<ProjectIteration> {
    const row = await this.database.transaction(async (transaction) => {
      const [updated] = await transaction.update(schema.iterations).set(delivery)
        .where(eq(schema.iterations.id, iterationId)).returning();
      const [project] = await transaction.select().from(schema.projects)
        .where(eq(schema.projects.id, updated.projectId)).limit(1);
      const records: Array<typeof schema.repositoryLifecycleRecords.$inferInsert> = [];
      if (delivery.issueNumber !== undefined) {
        records.push({
          projectId: updated.projectId,
          iterationId: updated.id,
          kind: 'issue_created',
          status: 'completed',
          repositoryUrl: project?.repositoryUrl,
          externalId: String(delivery.issueNumber),
          summary: `Repository issue #${delivery.issueNumber} is linked to iteration ${updated.number}.`,
          operationKey: `v1:delivery:${updated.id}:issue:${delivery.issueNumber}`,
        });
      }
      if (delivery.branchName !== undefined) {
        records.push({
          projectId: updated.projectId,
          iterationId: updated.id,
          kind: 'branch_created',
          status: 'completed',
          repositoryUrl: project?.repositoryUrl,
          externalId: delivery.branchName,
          summary: `Branch ${delivery.branchName} is linked to iteration ${updated.number}.`,
          metadata: { branchName: delivery.branchName },
          operationKey: `v1:delivery:${updated.id}:branch:${delivery.branchName}`,
        });
      }
      if (delivery.pullRequestNumber !== undefined || delivery.pullRequestUrl !== undefined) {
        const externalId = delivery.pullRequestNumber === undefined ? delivery.pullRequestUrl : String(delivery.pullRequestNumber);
        records.push({
          projectId: updated.projectId,
          iterationId: updated.id,
          kind: 'pull_request_opened',
          status: 'completed',
          repositoryUrl: project?.repositoryUrl,
          externalId,
          summary: `A pull request is linked to iteration ${updated.number}.`,
          metadata: {
            ...(delivery.pullRequestUrl ? { pullRequestUrl: delivery.pullRequestUrl } : {}),
            ...(delivery.branchName ? { branchName: delivery.branchName } : {}),
          },
          operationKey: `v1:delivery:${updated.id}:pull-request:${externalId}`,
        });
      }
      for (const record of records) {
        const [lifecycle] = await transaction.insert(schema.repositoryLifecycleRecords).values(record)
          .onConflictDoUpdate({
            target: [schema.repositoryLifecycleRecords.projectId, schema.repositoryLifecycleRecords.operationKey],
            set: {
              status: record.status,
              repositoryUrl: record.repositoryUrl,
              externalId: record.externalId,
              summary: record.summary,
              metadata: record.metadata ?? {},
            },
          }).returning();
        const operation = repositoryOperationValues(lifecycle);
        await transaction.insert(schema.repositoryOperations).values(operation).onConflictDoUpdate({
          target: [schema.repositoryOperations.projectId, schema.repositoryOperations.operationKey],
          set: {
            status: operation.status,
            branchName: operation.branchName,
            externalId: operation.externalId,
            summary: operation.summary,
            metadata: operation.metadata,
            completedAt: operation.completedAt,
          },
        });
      }
      return updated;
    });
    return this.toIteration(row);
  }

  async addEvent(
    input: Omit<ProjectEvent, 'id' | 'createdAt'>,
    operationKey?: string,
  ): Promise<ProjectEvent> {
    const assertCompatibleReplay = (row: typeof schema.projectEvents.$inferSelect) => {
      if (row.projectId !== input.projectId
        || row.iterationNumber !== input.iterationNumber
        || row.kind !== input.kind
        || row.title !== input.title
        || row.description !== input.description
        || row.agentRole !== input.agentRole) {
        throw new Error(`Event operation ${operationKey} was already used with a different payload.`);
      }
    };
    const values = {
      ...input,
      operationKey: operationKey ?? null,
    };
    const [created] = operationKey
      ? await this.database.insert(schema.projectEvents).values(values).onConflictDoNothing({
        target: [schema.projectEvents.projectId, schema.projectEvents.operationKey],
      }).returning()
      : await this.database.insert(schema.projectEvents).values(values).returning();
    if (created) {
      await this.database.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
      return this.toEvent(created);
    }
    const [row] = await this.database.select().from(schema.projectEvents).where(and(
      eq(schema.projectEvents.projectId, input.projectId),
      eq(schema.projectEvents.operationKey, operationKey!),
    )).limit(1);
    if (!row) throw new Error(`Event operation ${operationKey} conflicted but could not be reloaded.`);
    assertCompatibleReplay(row);
    return this.toEvent(row);
  }

  async addArtifact(
    projectId: string,
    iterationId: string,
    draft: AgentArtifactDraft,
    iterationNumber: number | null = null,
    operationKey?: string,
    options?: AddArtifactPersistenceOptions,
  ): Promise<ProjectArtifact> {
    const modelInvocationExecutionId = options?.modelInvocationExecutionId ?? draft.executionTrace?.executionId;
    const row = await this.database.transaction(async (transaction) => {
      if (operationKey) {
        const [existing] = await transaction.select().from(schema.artifacts).where(and(
          eq(schema.artifacts.projectId, projectId),
          eq(schema.artifacts.operationKey, operationKey),
        )).limit(1);
        if (existing) {
          assertCompatibleArtifactReplay(existing, projectId, iterationId, draft, operationKey, options);
          return existing;
        }
      }
      const [{ value }] = await transaction.select({ value: max(schema.artifacts.version) }).from(schema.artifacts)
        .where(and(eq(schema.artifacts.projectId, projectId), eq(schema.artifacts.type, draft.type)));
      const values = {
        projectId,
        iterationId,
        type: draft.type,
        name: draft.name,
        version: (value ?? 0) + 1,
        content: draft.content,
        mimeType: draft.mimeType,
        producedBy: draft.producedBy,
        model: draft.model,
        modelProvider: draft.modelProvider ?? null,
        modelInvocations: draft.modelInvocations ?? null,
        executionTrace: options?.stageForRepository ? null : draft.executionTrace ?? null,
        operationKey: operationKey ?? null,
        operationManifestHash: options?.operationManifestHash ?? null,
        operationPayload: options?.operationPayload ?? null,
        storageMode: options?.storage ?? 'repository',
        status: options?.stageForRepository ? 'draft' as const : 'ready_for_review' as const,
      };
      const [created] = operationKey
        ? await transaction.insert(schema.artifacts).values(values).onConflictDoNothing({
          target: [schema.artifacts.projectId, schema.artifacts.operationKey],
        }).returning()
        : await transaction.insert(schema.artifacts).values(values).returning();
      if (!created) {
        const [replayed] = await transaction.select().from(schema.artifacts).where(and(
          eq(schema.artifacts.projectId, projectId),
          eq(schema.artifacts.operationKey, operationKey!),
        )).limit(1);
        if (!replayed) throw new Error(`Artifact operation ${operationKey} conflicted but could not be reloaded.`);
        assertCompatibleArtifactReplay(replayed, projectId, iterationId, draft, operationKey!, options);
        return replayed;
      }
      const [producer] = await transaction.select({ id: schema.agents.id }).from(schema.agents).where(and(
        eq(schema.agents.projectId, projectId),
        eq(schema.agents.role, draft.producedBy),
      )).limit(1);
      await transaction.insert(schema.artifactVersions).values({
        projectId,
        iterationId,
        artifactId: created.id,
        producedByAgentId: producer?.id ?? null,
        version: created.version,
        status: created.status,
        content: created.content,
        mimeType: created.mimeType,
        contentHash: `sha256:${createHash('sha256').update(created.content).digest('hex')}`,
        sourceRevision: options?.sourceRevision ?? null,
          metadata: {
            source: 'project_artifacts',
            producedBy: draft.producedBy,
            model: draft.model,
            modelProvider: draft.modelProvider ?? null,
            storage: options?.storage ?? 'repository',
          },
        operationKey: sourceOperationKey('project_artifacts', created.id),
        createdAt: created.createdAt,
      });

      if (draft.modelInvocations?.length) {
        await transaction.insert(schema.modelInvocations).values(draft.modelInvocations.map((invocation, invocationIndex) => {
          const provider = invocation.provider ?? draft.modelProvider ?? 'ollama';
          const inputTokens = Math.trunc(invocation.usage?.promptTokens ?? 0);
          const outputTokens = Math.trunc(invocation.usage?.completionTokens ?? 0);
          const fingerprint = createHash('sha256').update(JSON.stringify({
            provider,
            model: invocation.model,
            purpose: invocation.purpose,
            round: invocation.round,
            usage: invocation.usage ?? null,
          })).digest('hex');
          return {
            projectId,
            iterationId,
            agentId: producer?.id ?? null,
            provider,
            model: invocation.model,
            purpose: invocation.purpose,
            status: 'succeeded' as const,
            externalRequestId: invocation.requestId ?? null,
            inputTokens,
            outputTokens,
            totalTokens: Math.trunc(invocation.usage?.totalTokens ?? inputTokens + outputTokens),
            costUsd: invocation.usage?.cost ?? 0,
            requestMetadata: {
              round: invocation.round,
              artifactId: created.id,
              artifactVersion: created.version,
            },
            responseMetadata: {},
            correlationId: `artifact:${created.id}`,
            operationKey: modelInvocationExecutionId
              ? dynamicExecutionModelInvocationOperationKey(modelInvocationExecutionId, invocationIndex)
              : options?.modelInvocationOperationPrefix
                ? `${options.modelInvocationOperationPrefix}:model-invocation:${invocationIndex}`
              : invocation.requestId
                ? `v1:model-invocation:${provider}:${invocation.requestId}`
                : `v1:model-invocation:${provider}:fingerprint:${fingerprint}`,
            createdAt: created.createdAt,
            startedAt: created.createdAt,
            completedAt: created.createdAt,
          };
        })).onConflictDoNothing({
          target: [schema.modelInvocations.projectId, schema.modelInvocations.operationKey],
        });
      }
      return created;
    });
    if (!options?.stageForRepository) {
      await this.addEvent({
        projectId,
        iterationNumber,
        kind: 'artifact',
        title: `${draft.name} is ready`,
        description: `${draft.producedBy} produced version ${row.version} for review.`,
        agentRole: draft.producedBy,
      }, operationKey ? `${operationKey}:event` : undefined);
    }
    return this.toArtifact(row);
  }

  async loadArtifactOperationDraft(
    projectId: string,
    rootArtifactOperationKey: string,
    expectedEnvelope?: ArtifactOperationRecoveryEnvelope,
  ): Promise<AgentArtifactDraft | undefined> {
    const [row] = await this.database.select().from(schema.artifacts).where(and(
      eq(schema.artifacts.projectId, projectId),
      eq(schema.artifacts.operationKey, rootArtifactOperationKey),
    )).limit(1);
    if (!row) return undefined;
    if (row.status !== 'draft' && row.status !== 'ready_for_review') return undefined;
    if (!row.operationPayload || !row.operationManifestHash) {
      throw new Error(`Artifact operation ${rootArtifactOperationKey} is missing its recovery snapshot.`);
    }
    const [version] = await this.database.select({
      sourceRevision: schema.artifactVersions.sourceRevision,
    }).from(schema.artifactVersions).where(and(
      eq(schema.artifactVersions.artifactId, row.id),
      eq(schema.artifactVersions.version, row.version),
    )).limit(1);
    if (!organismAgentRoles.includes(row.producedBy as AgentRole)) {
      throw new Error(`Artifact operation ${rootArtifactOperationKey} has an invalid producer role.`);
    }
    const durableEnvelope: ArtifactOperationRecoveryEnvelope = {
      iterationId: row.iterationId,
      type: row.type,
      producedBy: row.producedBy as AgentRole,
      storage: row.storageMode,
      sourceRevision: version?.sourceRevision ?? null,
    };
    if (expectedEnvelope && canonicalJson(durableEnvelope) !== canonicalJson(expectedEnvelope)) {
      throw new Error(`Artifact operation ${rootArtifactOperationKey} does not match its requested recovery envelope.`);
    }
    const manifest = expectedEnvelope
      ? { draft: row.operationPayload, envelope: durableEnvelope }
      : row.operationPayload;
    const actualHash = `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;
    if (actualHash !== row.operationManifestHash) {
      throw new Error(`Artifact operation ${rootArtifactOperationKey} has a corrupt recovery snapshot.`);
    }
    return row.operationPayload;
  }

  async rejectArtifacts(
    projectId: string,
    artifactIds: readonly string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(artifactIds)];
    if (uniqueIds.length === 0) return;
    await this.database.transaction(async (transaction) => {
      const rows = await transaction.select({
        id: schema.artifacts.id,
        status: schema.artifacts.status,
      }).from(schema.artifacts).where(and(
        eq(schema.artifacts.projectId, projectId),
        inArray(schema.artifacts.id, uniqueIds),
      )).for('update');
      if (rows.length !== uniqueIds.length) {
        throw new Error('One or more rejected artifacts do not belong to the requested project.');
      }
      if (rows.some((row) => row.status === 'approved')) {
        throw new Error('An approved artifact cannot be rejected by candidate preflight.');
      }
      await transaction.update(schema.artifacts).set({
        // Parent preflight rejected this exact candidate. Superseding it keeps
        // its audit record while preventing reactive context selection from
        // treating orphan attachments as still-actionable human feedback.
        status: 'superseded',
      }).where(and(
        eq(schema.artifacts.projectId, projectId),
        inArray(schema.artifacts.id, uniqueIds),
        inArray(schema.artifacts.status, ['draft', 'ready_for_review', 'changes_requested']),
      ));
      await transaction.update(schema.artifactVersions).set({
        status: 'superseded',
      }).where(and(
        eq(schema.artifactVersions.projectId, projectId),
        inArray(schema.artifactVersions.artifactId, uniqueIds),
      ));
    });
  }

  async locateArtifact(
    artifactId: string,
    repositoryPath: string,
    repositoryUrl: string,
    completion?: CompleteArtifactPersistenceOptions,
  ): Promise<ProjectArtifact> {
    const row = await this.database.transaction(async (transaction) => {
      const [located] = await transaction.update(schema.artifacts).set({
        repositoryPath,
        repositoryUrl,
        ...(completion ? {
          status: 'ready_for_review' as const,
          executionTrace: completion.executionTrace ?? null,
        } : {}),
      })
        .where(eq(schema.artifacts.id, artifactId)).returning();
      if (!located) throw new Error(`Artifact ${artifactId} does not exist.`);
      const [producer] = await transaction.select({ id: schema.agents.id }).from(schema.agents).where(and(
        eq(schema.agents.projectId, located.projectId),
        eq(schema.agents.role, located.producedBy as AgentRole),
      )).limit(1);
      await transaction.insert(schema.artifactVersions).values({
        projectId: located.projectId,
        iterationId: located.iterationId,
        artifactId: located.id,
        producedByAgentId: producer?.id ?? null,
        version: located.version,
        status: located.status,
        content: located.content,
        mimeType: located.mimeType,
        contentHash: `sha256:${createHash('sha256').update(located.content).digest('hex')}`,
        storageUri: repositoryUrl,
        repositoryPath,
        metadata: {
          source: 'project_artifacts',
          producedBy: located.producedBy,
          model: located.model,
          modelProvider: located.modelProvider,
        },
        operationKey: sourceOperationKey('project_artifacts', located.id),
        createdAt: located.createdAt,
      }).onConflictDoUpdate({
        target: [schema.artifactVersions.artifactId, schema.artifactVersions.version],
        set: {
          storageUri: repositoryUrl,
          repositoryPath,
          ...(completion ? { status: 'ready_for_review' as const } : {}),
        },
      });
      if (completion) {
        const event = {
          projectId: located.projectId,
          iterationNumber: completion.iterationNumber,
          kind: 'artifact' as const,
          title: `${located.name} is ready`,
          description: `${located.producedBy} produced version ${located.version} for review.`,
          agentRole: located.producedBy as AgentRole,
          operationKey: completion.eventOperationKey ?? null,
        };
        if (completion.eventOperationKey) {
          await transaction.insert(schema.projectEvents).values(event).onConflictDoNothing({
            target: [schema.projectEvents.projectId, schema.projectEvents.operationKey],
          });
        } else {
          await transaction.insert(schema.projectEvents).values(event);
        }
      }
      return located;
    });
    return this.toArtifact(row);
  }

  async addMedia(input: AddProjectMediaInput, operationKey?: string): Promise<ProjectMedia> {
    const {
      sourceRevision = null,
      imageDigest = null,
      expiresAt = null,
      ...media
    } = input;
    const expiration = expiresAt === null ? null : new Date(expiresAt);
    if (expiration && Number.isNaN(expiration.getTime())) throw new Error('Preview media expiresAt must be a valid timestamp.');
    const values = {
      ...media,
      sourceRevision,
      imageDigest,
      expiresAt: expiration,
      operationKey: operationKey ?? null,
    };
    const [created] = operationKey
      ? await this.database.insert(schema.projectMedia).values(values).onConflictDoNothing({
        target: [schema.projectMedia.projectId, schema.projectMedia.operationKey],
      }).returning()
      : await this.database.insert(schema.projectMedia).values(values).returning();
    let row = created;
    if (!row) {
      [row] = await this.database.select().from(schema.projectMedia).where(and(
        eq(schema.projectMedia.projectId, input.projectId),
        eq(schema.projectMedia.operationKey, operationKey!),
      )).limit(1);
      if (!row) throw new Error(`Media operation ${operationKey} conflicted but could not be reloaded.`);
      if (row.iterationId !== (input.iterationId ?? null)
        || row.kind !== input.kind
        || row.sourceRevision !== sourceRevision
        || row.imageDigest !== imageDigest
        || (row.expiresAt?.toISOString() ?? null) !== (expiration?.toISOString() ?? null)) {
        throw new Error(`Media operation ${operationKey} was already used with different evidence.`);
      }
    }
    await this.database.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
    return this.toMedia(row);
  }

  async addAgentQuestion(input: AgentQuestionInput, operationKey?: string): Promise<AgentQuestion> {
    const assertCompatibleReplay = (question: AgentQuestion) => {
      const optionsMatch = question.options.length === input.options.length
        && question.options.every((option, index) => {
          const expected = input.options[index];
          return expected !== undefined
            && option.value === expected.value
            && option.label === expected.label
            && (option.description ?? undefined) === expected.description;
        });
      if (question.projectId !== input.projectId
        || question.iterationId !== (input.iterationId ?? null)
        || question.agentRole !== input.agentRole
        || question.decisionKey !== canonicalDecisionKey(input)
        || question.question !== input.question
        || question.context !== (input.context ?? null)
        || question.allowCustomAnswer !== input.allowCustomAnswer
        || question.allowAgentDecide !== input.allowAgentDecide
        || !optionsMatch) {
        throw new Error(`Question operation ${operationKey} was already used with a different payload.`);
      }
    };
    if (operationKey) {
      const [existing] = await this.database.select({ id: schema.agentQuestions.id })
        .from(schema.agentQuestions).where(and(
          eq(schema.agentQuestions.projectId, input.projectId),
          eq(schema.agentQuestions.operationKey, operationKey),
        )).limit(1);
      if (existing) {
        const replayed = await this.findAgentQuestion(existing.id);
        if (!replayed) throw new Error(`Question operation ${operationKey} could not be reloaded.`);
        assertCompatibleReplay(replayed);
        return replayed;
      }
    }
    const questionId = await this.database.transaction(async (transaction) => {
      const values = {
        projectId: input.projectId,
        iterationId: input.iterationId ?? null,
        agentRole: input.agentRole,
        decisionKey: canonicalDecisionKey(input),
        question: input.question,
        context: input.context ?? null,
        allowCustomAnswer: input.allowCustomAnswer,
        allowAgentDecide: input.allowAgentDecide,
        operationKey: operationKey ?? null,
      };
      const [question] = operationKey
        ? await transaction.insert(schema.agentQuestions).values(values).onConflictDoNothing({
          target: [schema.agentQuestions.projectId, schema.agentQuestions.operationKey],
        }).returning({ id: schema.agentQuestions.id })
        : await transaction.insert(schema.agentQuestions).values(values).returning({ id: schema.agentQuestions.id });
      if (!question) {
        const [replayed] = await transaction.select({ id: schema.agentQuestions.id })
          .from(schema.agentQuestions).where(and(
            eq(schema.agentQuestions.projectId, input.projectId),
            eq(schema.agentQuestions.operationKey, operationKey!),
          )).limit(1);
        if (!replayed) throw new Error(`Question operation ${operationKey} conflicted but could not be reloaded.`);
        return replayed.id;
      }
      await transaction.insert(schema.agentQuestionOptions).values(input.options.map((option, position) => ({
        questionId: question.id,
        value: option.value,
        label: option.label,
        description: option.description ?? null,
        position,
      })));
      return question.id;
    });
    const question = await this.findAgentQuestion(questionId);
    if (!question) throw new Error(`Question ${questionId} was not persisted.`);
    if (operationKey) assertCompatibleReplay(question);
    await this.reuseExistingDecision(question);
    return (await this.findAgentQuestion(questionId)) ?? question;
  }

  async findAgentQuestion(questionId: string): Promise<AgentQuestion | undefined> {
    const [question] = await this.database.select().from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.id, questionId)).limit(1);
    if (!question) return undefined;
    const [options, answers] = await Promise.all([
      this.database.select().from(schema.agentQuestionOptions)
        .where(eq(schema.agentQuestionOptions.questionId, questionId))
        .orderBy(schema.agentQuestionOptions.position),
      this.database.select().from(schema.agentQuestionAnswers)
        .where(eq(schema.agentQuestionAnswers.questionId, questionId)).limit(1),
    ]);
    return this.toAgentQuestion(question, options, answers[0]);
  }

  async listAgentQuestions(projectId: string): Promise<AgentQuestion[]> {
    const questions = await this.database.select().from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.projectId, projectId)).orderBy(desc(schema.agentQuestions.createdAt));
    if (questions.length === 0) return [];
    const questionIds = questions.map((question) => question.id);
    const [options, answers] = await Promise.all([
      this.database.select().from(schema.agentQuestionOptions)
        .where(inArray(schema.agentQuestionOptions.questionId, questionIds))
        .orderBy(schema.agentQuestionOptions.position),
      this.database.select().from(schema.agentQuestionAnswers)
        .where(inArray(schema.agentQuestionAnswers.questionId, questionIds)),
    ]);
    return questions.map((question) => this.toAgentQuestion(
      question,
      options.filter((option) => option.questionId === question.id),
      answers.find((answer) => answer.questionId === question.id),
    ));
  }

  async answerAgentQuestion(
    questionId: string,
    input: AgentQuestionAnswerInput,
    answeredBy: 'human' | 'agent' = 'human',
    expectedProjectId?: string,
    reuse?: { sourceQuestionId?: string; propagate?: boolean },
  ): Promise<AgentQuestion> {
    await this.database.transaction(async (transaction) => {
      const [question] = await transaction.select().from(schema.agentQuestions)
        .where(eq(schema.agentQuestions.id, questionId)).limit(1);
      if (!question) throw new Error(`Question ${questionId} does not exist.`);
      if (expectedProjectId !== undefined && question.projectId !== expectedProjectId) {
        throw new Error(`Question ${questionId} does not belong to project ${expectedProjectId}.`);
      }
      // Temporal Activities may be retried after the database commit but
      // before their completion is recorded, and a person may submit the same
      // UI answer more than once. The first accepted answer is authoritative;
      // replayed submissions are successful no-ops instead of workflow-fatal
      // conflicts.
      if (question.status === 'answered') return;
      if (question.status !== 'pending') throw new Error(`Question ${questionId} is no longer pending.`);

      let selectedOption: string;
      let answerRow: typeof schema.agentQuestionAnswers.$inferSelect;
      if (input.resolution === 'selected_option') {
        const [option] = await transaction.select().from(schema.agentQuestionOptions)
          .where(and(
            eq(schema.agentQuestionOptions.id, input.optionId),
            eq(schema.agentQuestionOptions.questionId, questionId),
          )).limit(1);
        if (!option) throw new Error('The selected option does not belong to this question.');
        [answerRow] = await transaction.insert(schema.agentQuestionAnswers).values({
          questionId,
          resolution: input.resolution,
          optionId: input.optionId,
          answeredBy,
        }).returning();
        selectedOption = option.value;
      } else if (input.resolution === 'custom') {
        if (!question.allowCustomAnswer) throw new Error('This question does not allow a custom answer.');
        [answerRow] = await transaction.insert(schema.agentQuestionAnswers).values({
          questionId,
          resolution: input.resolution,
          answer: input.answer,
          answeredBy,
        }).returning();
        selectedOption = input.answer;
      } else {
        if (!question.allowAgentDecide) throw new Error('This question does not allow the agent to decide.');
        [answerRow] = await transaction.insert(schema.agentQuestionAnswers).values({
          questionId,
          resolution: input.resolution,
          answeredBy,
        }).returning();
        selectedOption = 'agent_decides';
      }

      const optionsConsidered = await transaction.select({ value: schema.agentQuestionOptions.value })
        .from(schema.agentQuestionOptions)
        .where(eq(schema.agentQuestionOptions.questionId, questionId))
        .orderBy(schema.agentQuestionOptions.position);
      await transaction.insert(schema.humanDecisions).values({
        projectId: question.projectId,
        iterationId: question.iterationId,
        questionId: question.id,
        decisionKey: normalizeDecisionKey(question.decisionKey),
        decisionType: 'question_answer',
        selectedOption,
        rationale: question.context ?? '',
        decidedBy: answeredBy,
        status: 'recorded',
        optionsConsidered: optionsConsidered.map((option) => option.value),
        appliesTo: [`question:${question.id}`, `decision:${normalizeDecisionKey(question.decisionKey)}`],
        authority: {
          source: 'agent_question_answers',
          resolution: input.resolution,
          ...(reuse?.sourceQuestionId ? { reusedFromQuestionId: reuse.sourceQuestionId } : {}),
        },
        correlationId: `decision:${normalizeDecisionKey(question.decisionKey)}`,
        operationKey: sourceOperationKey('agent_question_answers', answerRow.id),
        createdAt: answerRow.createdAt,
      });

      await transaction.update(schema.agentQuestions).set({
        status: 'answered',
        reusedFromQuestionId: reuse?.sourceQuestionId ?? null,
        updatedAt: new Date(),
      })
        .where(eq(schema.agentQuestions.id, questionId));
    });
    const question = await this.findAgentQuestion(questionId);
    if (!question) throw new Error(`Question ${questionId} disappeared after it was answered.`);
    if (reuse?.propagate !== false) await this.propagateDecision(question);
    return question;
  }

  async reconcileAgentQuestionDecisions(projectId: string): Promise<number> {
    const questions = await this.listAgentQuestions(projectId);
    let reused = 0;
    for (const target of questions.filter((question) => question.status === 'pending')) {
      const source = questions.find((question) =>
        question.status === 'answered'
        && normalizeDecisionKey(question.decisionKey) === normalizeDecisionKey(target.decisionKey)
        && question.id !== target.id,
      );
      if (!source) continue;
      const answer = reusableAnswer(source, target);
      if (!answer) continue;
      await this.answerAgentQuestion(target.id, answer, source.answer?.answeredBy ?? 'human', projectId, {
        sourceQuestionId: source.id,
        propagate: false,
      });
      reused += 1;
    }
    return reused;
  }

  private async reuseExistingDecision(target: AgentQuestion): Promise<void> {
    const questions = await this.listAgentQuestions(target.projectId);
    const source = questions.find((question) =>
      question.status === 'answered'
      && normalizeDecisionKey(question.decisionKey) === normalizeDecisionKey(target.decisionKey)
      && question.id !== target.id,
    );
    if (!source) return;
    const answer = reusableAnswer(source, target);
    if (!answer) return;
    await this.answerAgentQuestion(target.id, answer, source.answer?.answeredBy ?? 'human', target.projectId, {
      sourceQuestionId: source.id,
      propagate: false,
    });
  }

  private async propagateDecision(source: AgentQuestion): Promise<void> {
    const questions = await this.listAgentQuestions(source.projectId);
    for (const target of questions.filter((question) =>
      question.status === 'pending'
      && normalizeDecisionKey(question.decisionKey) === normalizeDecisionKey(source.decisionKey)
      && question.id !== source.id,
    )) {
      const answer = reusableAnswer(source, target);
      if (!answer) continue;
      await this.answerAgentQuestion(target.id, answer, source.answer?.answeredBy ?? 'human', source.projectId, {
        sourceQuestionId: source.id,
        propagate: false,
      });
    }
  }

  async answerProjectAgentQuestion(
    projectId: string,
    questionId: string,
    input: AgentQuestionAnswerInput,
    answeredBy: 'human' | 'agent' = 'human',
  ): Promise<AgentQuestion> {
    return this.answerAgentQuestion(questionId, input, answeredBy, projectId);
  }

  async dismissAgentQuestion(questionId: string): Promise<boolean> {
    const [question] = await this.database.update(schema.agentQuestions)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(and(eq(schema.agentQuestions.id, questionId), eq(schema.agentQuestions.status, 'pending')))
      .returning({ id: schema.agentQuestions.id });
    return question !== undefined;
  }

  async addAgentComment(input: AgentCommentInput): Promise<AgentComment> {
    if (input.iterationId) {
      const [iteration] = await this.database.select({ id: schema.iterations.id }).from(schema.iterations)
        .where(and(
          eq(schema.iterations.id, input.iterationId),
          eq(schema.iterations.projectId, input.projectId),
        )).limit(1);
      if (!iteration) throw new Error(`Iteration ${input.iterationId} does not belong to project ${input.projectId}.`);
    }
    const row = await this.database.transaction(async (transaction) => {
      const [created] = await transaction.insert(schema.agentComments).values({
        projectId: input.projectId,
        iterationId: input.iterationId ?? null,
        agentRole: input.agentRole,
        body: input.body,
        authorType: input.authorType,
        authorRole: input.authorRole ?? null,
      }).returning();
      if (input.authorType === 'human') {
        const [agent] = await transaction.select({ id: schema.agents.id }).from(schema.agents).where(and(
          eq(schema.agents.projectId, input.projectId),
          eq(schema.agents.role, input.agentRole),
        )).limit(1);
        await transaction.insert(schema.humanFeedback).values({
          projectId: input.projectId,
          iterationId: input.iterationId ?? null,
          agentId: agent?.id ?? null,
          type: 'agent_comment',
          body: input.body,
          authorId: 'human',
          status: 'received',
          metadata: {
            source: 'agent_comments',
            sourceId: created.id,
            authorType: input.authorType,
          },
          correlationId: `agent:${input.agentRole}:feedback`,
          operationKey: sourceOperationKey('agent_comments', created.id),
          createdAt: created.createdAt,
        });
      }
      return created;
    });
    return this.toAgentComment(row);
  }

  async listAgentComments(projectId: string): Promise<AgentComment[]> {
    const rows = await this.database.select().from(schema.agentComments)
      .where(eq(schema.agentComments.projectId, projectId)).orderBy(desc(schema.agentComments.createdAt));
    return rows.map((row) => this.toAgentComment(row));
  }

  async addArtifactFeedback(
    input: ArtifactFeedbackInput,
    reviewId: string | null = null,
    expectedProjectId?: string,
  ): Promise<ArtifactFeedback> {
    const [artifact] = await this.database.select().from(schema.artifacts)
      .where(eq(schema.artifacts.id, input.artifactId)).limit(1);
    if (!artifact) throw new Error(`Artifact ${input.artifactId} does not exist.`);
    if (expectedProjectId !== undefined && artifact.projectId !== expectedProjectId) {
      throw new Error(`Artifact ${input.artifactId} does not belong to project ${expectedProjectId}.`);
    }
    if (reviewId !== null) {
      const [review] = await this.database.select().from(schema.iterationReviews)
        .where(eq(schema.iterationReviews.id, reviewId)).limit(1);
      if (!review || review.projectId !== artifact.projectId || review.iterationId !== artifact.iterationId) {
        throw new Error(`Review ${reviewId} does not cover artifact ${input.artifactId}.`);
      }
    }
    const row = await this.database.transaction(async (transaction) => {
      const [created] = await transaction.insert(schema.artifactFeedback).values({
        projectId: artifact.projectId,
        iterationId: artifact.iterationId,
        artifactId: artifact.id,
        reviewId,
        feedback: input.feedback,
      }).returning();
      const [version] = await transaction.select({ id: schema.artifactVersions.id }).from(schema.artifactVersions)
        .where(and(
          eq(schema.artifactVersions.artifactId, artifact.id),
          eq(schema.artifactVersions.version, artifact.version),
        )).limit(1);
      await transaction.insert(schema.humanFeedback).values({
        projectId: artifact.projectId,
        iterationId: artifact.iterationId,
        reviewId,
        artifactId: artifact.id,
        artifactVersionId: version?.id ?? null,
        type: 'artifact_feedback',
        body: input.feedback,
        authorId: 'human',
        status: 'received',
        metadata: { source: 'artifact_feedback', sourceId: created.id },
        correlationId: `artifact:${artifact.id}:feedback`,
        operationKey: sourceOperationKey('artifact_feedback', created.id),
        createdAt: created.createdAt,
      });
      return created;
    });
    return this.toArtifactFeedback(row);
  }

  async addProjectArtifactFeedback(
    projectId: string,
    input: ArtifactFeedbackInput,
    reviewId: string | null = null,
  ): Promise<ArtifactFeedback> {
    return this.addArtifactFeedback(input, reviewId, projectId);
  }

  async listArtifactFeedback(projectId: string): Promise<ArtifactFeedback[]> {
    const rows = await this.database.select().from(schema.artifactFeedback)
      .where(eq(schema.artifactFeedback.projectId, projectId)).orderBy(desc(schema.artifactFeedback.createdAt));
    return rows.map((row) => this.toArtifactFeedback(row));
  }

  async recordRepositoryLifecycle(
    input: RepositoryLifecycleInput,
    operationKey?: string,
  ): Promise<RepositoryLifecycleRecord> {
    const row = await this.database.transaction(async (transaction) => {
      let lifecycle: typeof schema.repositoryLifecycleRecords.$inferSelect | undefined;
      if (operationKey) {
        [lifecycle] = await transaction.select().from(schema.repositoryLifecycleRecords).where(and(
          eq(schema.repositoryLifecycleRecords.projectId, input.projectId),
          eq(schema.repositoryLifecycleRecords.operationKey, operationKey),
        )).limit(1).for('update');
      }
      if (!lifecycle) {
        [lifecycle] = await transaction.insert(schema.repositoryLifecycleRecords).values({
          projectId: input.projectId,
          iterationId: input.iterationId ?? null,
          kind: input.kind,
          status: input.status,
          repositoryUrl: input.repositoryUrl ?? null,
          externalId: input.externalId ?? null,
          summary: input.summary,
          metadata: input.metadata,
          operationKey: operationKey ?? null,
        }).returning();
      }
      const operation = repositoryOperationValues(lifecycle);
      await transaction.insert(schema.repositoryOperations).values(operation).onConflictDoUpdate({
        target: [schema.repositoryOperations.projectId, schema.repositoryOperations.operationKey],
        set: {
          status: operation.status,
          mutating: operation.mutating,
          repositoryUrl: operation.repositoryUrl,
          branchName: operation.branchName,
          paths: operation.paths,
          expectedBaseRevision: operation.expectedBaseRevision,
          resultingRevision: operation.resultingRevision,
          externalId: operation.externalId,
          summary: operation.summary,
          metadata: operation.metadata,
          correlationId: operation.correlationId,
          completedAt: operation.completedAt,
        },
      });
      return lifecycle;
    });
    return this.toRepositoryLifecycle(row);
  }

  async listRepositoryLifecycle(projectId: string): Promise<RepositoryLifecycleRecord[]> {
    const rows = await this.database.select().from(schema.repositoryLifecycleRecords)
      .where(eq(schema.repositoryLifecycleRecords.projectId, projectId))
      .orderBy(desc(schema.repositoryLifecycleRecords.createdAt));
    return rows.map((row) => this.toRepositoryLifecycle(row));
  }

  async reviewIteration(
    projectId: string,
    iterationNumber: number,
    review: IterationReview,
    operationKey?: string,
  ) {
    const [iteration] = await this.database.select().from(schema.iterations)
      .where(and(eq(schema.iterations.projectId, projectId), eq(schema.iterations.number, iterationNumber))).limit(1);
    if (!iteration) return false;
    const approved = review.decision === 'approve' || review.decision === 'approved';
    const persistedDecision = approved ? 'approve' : 'request_changes';
    const direction = review.overallDirection ?? review.feedback;
    const previewRevision = review.previewAttestation?.revision ?? null;
    const previewImageDigest = review.previewAttestation?.imageDigest ?? null;
    const previewTriedAt = review.previewAttestation ? new Date(review.previewAttestation.triedAt) : null;
    if (previewTriedAt && Number.isNaN(previewTriedAt.getTime())) {
      throw new Error('Preview attestation triedAt must be a valid timestamp.');
    }
    if (operationKey) {
      const [existingReview] = await this.database.select().from(schema.iterationReviews).where(and(
        eq(schema.iterationReviews.projectId, projectId),
        eq(schema.iterationReviews.operationKey, operationKey),
      )).limit(1);
      if (existingReview) {
        if (existingReview.iterationId !== iteration.id
          || existingReview.iterationNumber !== iterationNumber
          || existingReview.decision !== persistedDecision
          || existingReview.feedback !== review.feedback
          || existingReview.overallDirection !== direction
          || existingReview.previewRevision !== previewRevision
          || existingReview.previewImageDigest !== previewImageDigest
          || existingReview.previewTriedAt?.getTime() !== previewTriedAt?.getTime()) {
          throw new Error(`Review operation ${operationKey} was already used with a different payload.`);
        }
        return true;
      }
    }
    const suppliedAgentFeedback = new Map(review.agentFeedback?.map((entry) => [entry.role, entry.feedback]));
    const overallFeedback = [...new Set([review.feedback.trim(), direction.trim()].filter(Boolean))].join('\n\n');
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction.update(schema.iterations).set({
        status: approved ? 'approved' : 'changes_requested',
        completedAt: null,
      }).where(eq(schema.iterations.id, iteration.id));
      await transaction.update(schema.artifacts).set({
        status: approved ? 'ready_for_review' : 'changes_requested',
        reviewedAt: now,
      }).where(and(
        eq(schema.artifacts.iterationId, iteration.id),
        ne(schema.artifacts.status, 'superseded'),
      ));
      await transaction.update(schema.artifactVersions).set({
        status: approved ? 'ready_for_review' : 'changes_requested',
      }).where(and(
        eq(schema.artifactVersions.iterationId, iteration.id),
        ne(schema.artifactVersions.status, 'superseded'),
      ));
      if (previewRevision) {
        await transaction.update(schema.iterationReviewProposals).set({
          status: approved ? 'accepted' : 'rejected',
          resolvedAt: now,
          updatedAt: now,
        }).where(and(
          eq(schema.iterationReviewProposals.iterationId, iteration.id),
          eq(schema.iterationReviewProposals.includedRevision, previewRevision),
          inArray(schema.iterationReviewProposals.status, ['draft', 'proposed', 'gate_blocked']),
        ));
      }
      const [reviewRow] = await transaction.insert(schema.iterationReviews).values({
        projectId,
        iterationId: iteration.id,
        iterationNumber,
        decision: persistedDecision,
        feedback: review.feedback,
        overallDirection: direction,
        previewRevision,
        previewImageDigest,
        previewTriedAt,
        operationKey: operationKey ?? null,
        createdAt: now,
      }).returning();
      const agentFeedbackRows = await transaction.insert(schema.iterationAgentFeedback).values(organismAgentRoles.map((role) => ({
        reviewId: reviewRow.id,
        role,
        feedback: suppliedAgentFeedback.get(role) ?? '',
        createdAt: now,
      }))).returning();

      const reviewCorrelationId = operationKey ?? `iteration:${iteration.id}:review:${reviewRow.id}`;
      await transaction.insert(schema.humanDecisions).values({
        projectId,
        iterationId: iteration.id,
        reviewId: reviewRow.id,
        decisionKey: `iteration.${iterationNumber}.review`,
        decisionType: 'iteration_review',
        selectedOption: persistedDecision,
        rationale: direction,
        decidedBy: 'human',
        status: 'recorded',
        optionsConsidered: ['approve', 'request_changes'],
        appliesTo: [`iteration:${iteration.id}`],
        authority: { source: 'iteration_reviews' },
        correlationId: reviewCorrelationId,
        operationKey: sourceOperationKey('iteration_reviews', reviewRow.id),
        createdAt: reviewRow.createdAt,
      });
      if (overallFeedback) {
        await transaction.insert(schema.humanFeedback).values({
          projectId,
          iterationId: iteration.id,
          reviewId: reviewRow.id,
          type: 'iteration_review_feedback',
          body: overallFeedback,
          authorId: 'human',
          status: 'received',
          metadata: {
            source: 'iteration_reviews',
            sourceId: reviewRow.id,
            decision: persistedDecision,
          },
          correlationId: reviewCorrelationId,
          operationKey: sourceOperationKey('iteration_reviews', reviewRow.id, 'feedback'),
          createdAt: reviewRow.createdAt,
        });
      }
      const meaningfulAgentFeedback = agentFeedbackRows.filter((feedback) => feedback.feedback.trim());
      if (meaningfulAgentFeedback.length > 0) {
        const targetAgents = await transaction.select({ id: schema.agents.id, role: schema.agents.role })
          .from(schema.agents)
          .where(and(
            eq(schema.agents.projectId, projectId),
            inArray(schema.agents.role, meaningfulAgentFeedback.map((feedback) => feedback.role)),
          ));
        const agentByRole = new Map(targetAgents.map((agent) => [agent.role, agent.id]));
        await transaction.insert(schema.humanFeedback).values(meaningfulAgentFeedback.map((feedback) => ({
          projectId,
          iterationId: iteration.id,
          reviewId: reviewRow.id,
          agentId: agentByRole.get(feedback.role) ?? null,
          type: 'iteration_agent_feedback',
          body: feedback.feedback,
          authorId: 'human',
          status: 'received' as const,
          metadata: {
            source: 'iteration_agent_feedback',
            sourceId: feedback.id,
            role: feedback.role,
          },
          correlationId: reviewCorrelationId,
          operationKey: sourceOperationKey('iteration_agent_feedback', feedback.id),
          createdAt: feedback.createdAt,
        })));
      }

      const artifactFeedbackInputs = review.artifactFeedback ?? [];
      if (artifactFeedbackInputs.length > 0) {
        const artifactIds = [...new Set(artifactFeedbackInputs.map((entry) => entry.artifactId))];
        const artifactRows = await transaction.select().from(schema.artifacts)
          .where(and(
            eq(schema.artifacts.iterationId, iteration.id),
            inArray(schema.artifacts.id, artifactIds),
          ));
        const artifactsById = new Map(artifactRows.map((artifact) => [artifact.id, artifact]));
        const artifactVersionRows = await transaction.select({
          id: schema.artifactVersions.id,
          artifactId: schema.artifactVersions.artifactId,
          version: schema.artifactVersions.version,
        }).from(schema.artifactVersions).where(inArray(schema.artifactVersions.artifactId, artifactIds));
        const artifactVersionByKey = new Map(artifactVersionRows.map((version) => [
          `${version.artifactId}:${version.version}`,
          version.id,
        ]));
        for (const feedback of artifactFeedbackInputs) {
          const artifact = artifactsById.get(feedback.artifactId);
          if (!artifact) throw new Error(`Artifact ${feedback.artifactId} does not belong to iteration ${iterationNumber}.`);
          const [feedbackRow] = await transaction.insert(schema.artifactFeedback).values({
            projectId,
            iterationId: iteration.id,
            artifactId: artifact.id,
            reviewId: reviewRow.id,
            feedback: feedback.feedback,
            createdAt: now,
          }).returning();
          if (feedback.feedback.trim()) {
            await transaction.insert(schema.humanFeedback).values({
              projectId,
              iterationId: iteration.id,
              reviewId: reviewRow.id,
              artifactId: artifact.id,
              artifactVersionId: artifactVersionByKey.get(`${artifact.id}:${artifact.version}`) ?? null,
              type: 'artifact_feedback',
              body: feedback.feedback,
              authorId: 'human',
              status: 'received',
              metadata: { source: 'artifact_feedback', sourceId: feedbackRow.id },
              correlationId: reviewCorrelationId,
              operationKey: sourceOperationKey('artifact_feedback', feedbackRow.id),
              createdAt: feedbackRow.createdAt,
            });
          }
        }
      }

      await transaction.insert(schema.projectEvents).values({
        projectId,
        iterationNumber,
        kind: 'review',
        title: approved ? 'Iteration approval recorded' : 'Changes requested',
        description: direction || (approved ? 'Human approval is recorded; completion awaits a confirmed repository merge.' : 'The iteration will be revised.'),
        operationKey: operationKey ? `${operationKey}:review-event` : null,
      });
      const [project] = await transaction.select().from(schema.projects)
        .where(eq(schema.projects.id, projectId)).limit(1);
      if (project?.repositoryUrl) {
        const [lifecycle] = await transaction.insert(schema.repositoryLifecycleRecords).values({
          projectId,
          iterationId: iteration.id,
          kind: 'review_recorded',
          status: 'completed',
          repositoryUrl: project.repositoryUrl,
          externalId: iteration.pullRequestNumber === null ? null : String(iteration.pullRequestNumber),
          summary: approved ? 'The human approved the candidate; repository merge is still pending.' : 'The human iteration review requested changes.',
          metadata: { decision: persistedDecision },
          operationKey: operationKey ? `${operationKey}:review-lifecycle` : null,
          createdAt: now,
        }).returning();
        const operation = repositoryOperationValues(lifecycle);
        await transaction.insert(schema.repositoryOperations).values(operation).onConflictDoUpdate({
          target: [schema.repositoryOperations.projectId, schema.repositoryOperations.operationKey],
          set: {
            status: operation.status,
            externalId: operation.externalId,
            summary: operation.summary,
            metadata: operation.metadata,
            completedAt: operation.completedAt,
          },
        });
      }
      await transaction.update(schema.projects).set({ updatedAt: now }).where(eq(schema.projects.id, projectId));
    });
    return true;
  }

  async completeMergedIteration(projectId: string, iterationNumber: number): Promise<boolean> {
    const [iteration] = await this.database.select().from(schema.iterations)
      .where(and(eq(schema.iterations.projectId, projectId), eq(schema.iterations.number, iterationNumber))).limit(1);
    if (!iteration) return false;
    if (iteration.status === 'completed') return true;
    if (iteration.status !== 'approved') {
      throw new Error(`Iteration ${iterationNumber} cannot complete from ${iteration.status}; human approval is required before merge completion.`);
    }
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction.update(schema.iterations).set({
        status: 'completed',
        completedAt: now,
      }).where(eq(schema.iterations.id, iteration.id));
      await transaction.update(schema.artifacts).set({
        status: 'approved',
        reviewedAt: now,
      }).where(and(
        eq(schema.artifacts.iterationId, iteration.id),
        ne(schema.artifacts.status, 'superseded'),
      ));
      await transaction.update(schema.artifactVersions).set({ status: 'approved' })
        .where(and(
          eq(schema.artifactVersions.iterationId, iteration.id),
          ne(schema.artifactVersions.status, 'superseded'),
        ));
      await transaction.insert(schema.projectEvents).values({
        projectId,
        iterationNumber,
        kind: 'review',
        title: 'Iteration completed after merge',
        description: 'Forgejo confirmed the approved pull request merge before completion was recorded.',
        agentRole: 'gate',
        createdAt: now,
      });
      await transaction.update(schema.projects).set({ updatedAt: now }).where(eq(schema.projects.id, projectId));
    });
    return true;
  }

  async listIterationReviews(projectId: string): Promise<IterationReviewRecord[]> {
    const reviews = await this.database.select().from(schema.iterationReviews)
      .where(eq(schema.iterationReviews.projectId, projectId)).orderBy(desc(schema.iterationReviews.createdAt));
    if (reviews.length === 0) return [];
    const reviewIds = reviews.map((review) => review.id);
    const [feedbackRows, artifactFeedbackRows] = await Promise.all([
      this.database.select().from(schema.iterationAgentFeedback)
        .where(inArray(schema.iterationAgentFeedback.reviewId, reviewIds)),
      this.database.select().from(schema.artifactFeedback)
        .where(inArray(schema.artifactFeedback.reviewId, reviewIds)),
    ]);
    return reviews.map((review) => ({
      id: review.id,
      projectId: review.projectId,
      iterationId: review.iterationId,
      iterationNumber: review.iterationNumber,
      decision: review.decision,
      feedback: review.feedback,
      overallDirection: review.overallDirection,
      agentFeedback: feedbackRows
        .filter((feedback) => feedback.reviewId === review.id)
        .map((feedback) => ({
          id: feedback.id,
          reviewId: feedback.reviewId,
          role: feedback.role,
          feedback: feedback.feedback,
          createdAt: feedback.createdAt.toISOString(),
        })),
      artifactFeedback: artifactFeedbackRows
        .filter((feedback) => feedback.reviewId === review.id)
        .map((feedback) => this.toArtifactFeedback(feedback)),
      previewAttestation: review.previewRevision && review.previewImageDigest && review.previewTriedAt
        ? {
            revision: review.previewRevision,
            imageDigest: review.previewImageDigest,
            triedAt: review.previewTriedAt.toISOString(),
          }
        : null,
      createdAt: review.createdAt.toISOString(),
    }));
  }

  async close() {
    await this.pool.end();
  }

  private toContract(row: typeof schema.projects.$inferSelect): Project {
    return {
      ...row,
      forgejoProjectId: row.forgejoProjectId ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toIteration(row: typeof schema.iterations.$inferSelect): ProjectIteration {
    return { ...row, startedAt: row.startedAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null };
  }

  private toEvent(row: typeof schema.projectEvents.$inferSelect): ProjectEvent {
    return { ...row, agentRole: row.agentRole as AgentRole | null, createdAt: row.createdAt.toISOString() };
  }

  private toArtifact(row: typeof schema.artifacts.$inferSelect): ProjectArtifact {
    const {
      operationKey: _operationKey,
      operationManifestHash: _operationManifestHash,
      operationPayload: _operationPayload,
      ...artifact
    } = row;
    return {
      ...artifact,
      producedBy: row.producedBy as AgentRole,
      mimeType: row.mimeType,
      modelInvocations: row.modelInvocations ?? undefined,
      executionTrace: row.executionTrace ?? undefined,
      createdAt: row.createdAt.toISOString(),
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
    };
  }

  private toMedia(row: typeof schema.projectMedia.$inferSelect): ProjectMedia {
    return {
      ...row,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAgentQuestion(
    row: typeof schema.agentQuestions.$inferSelect,
    optionRows: Array<typeof schema.agentQuestionOptions.$inferSelect>,
    answerRow?: typeof schema.agentQuestionAnswers.$inferSelect,
  ): AgentQuestion {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      agentRole: row.agentRole,
      decisionKey: row.decisionKey,
      reusedFromQuestionId: row.reusedFromQuestionId,
      question: row.question,
      context: row.context,
      status: row.status,
      allowCustomAnswer: row.allowCustomAnswer,
      allowAgentDecide: row.allowAgentDecide,
      options: optionRows.map((option) => ({
        id: option.id,
        questionId: option.questionId,
        value: option.value,
        label: option.label,
        description: option.description ?? undefined,
        position: option.position,
      })),
      answer: answerRow ? this.toAgentQuestionAnswer(answerRow) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toAgentQuestionAnswer(row: typeof schema.agentQuestionAnswers.$inferSelect): AgentQuestionAnswer {
    const common = {
      id: row.id,
      questionId: row.questionId,
      answeredBy: row.answeredBy,
      createdAt: row.createdAt.toISOString(),
    };
    if (row.resolution === 'selected_option') {
      if (!row.optionId) throw new Error(`Selected-option answer ${row.id} has no option.`);
      return { ...common, resolution: row.resolution, optionId: row.optionId };
    }
    if (row.resolution === 'custom') {
      if (!row.answer) throw new Error(`Custom answer ${row.id} has no text.`);
      return { ...common, resolution: row.resolution, answer: row.answer };
    }
    return { ...common, resolution: row.resolution };
  }

  private toAgentComment(row: typeof schema.agentComments.$inferSelect): AgentComment {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      agentRole: row.agentRole,
      body: row.body,
      authorType: row.authorType,
      authorRole: row.authorRole,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toArtifactFeedback(row: typeof schema.artifactFeedback.$inferSelect): ArtifactFeedback {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      artifactId: row.artifactId,
      reviewId: row.reviewId,
      feedback: row.feedback,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toRepositoryLifecycle(row: typeof schema.repositoryLifecycleRecords.$inferSelect): RepositoryLifecycleRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      kind: row.kind,
      status: row.status,
      repositoryUrl: row.repositoryUrl,
      externalId: row.externalId,
      summary: row.summary,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAgentGoal(
    row: typeof schema.agentGoals.$inferSelect,
    role: AgentRole,
  ): AgentGoalRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      role,
      objective: row.objective,
      status: row.status,
      priority: row.priority,
      successCriteria: row.successCriteria,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private toAgentActionPlan(
    row: typeof schema.agentActionPlans.$inferSelect,
    role: AgentRole,
  ): AgentActionPlanRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      role,
      goalId: row.goalId,
      version: row.version,
      summary: row.summary,
      rationale: row.rationale,
      status: row.status,
      sourceRevision: row.sourceRevision,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private toAgentAction(
    row: typeof schema.agentActions.$inferSelect,
    role: AgentRole,
  ): AgentActionRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      role,
      planId: row.planId,
      position: row.position,
      kind: row.kind,
      summary: row.summary,
      status: row.status,
      blocking: row.blocking,
      dependencyActionIds: row.dependencyActionIds,
      input: row.input,
      output: row.output,
      error: row.error,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private toAgentObligation(
    row: typeof schema.agentObligations.$inferSelect,
    ownerRole: AgentRole,
  ): AgentObligationRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      ownerRole,
      goalId: row.goalId,
      actionId: row.actionId,
      type: row.type,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      mandatory: row.mandatory,
      blocking: row.blocking,
      subjectReferences: row.subjectReferences,
      dependencyReferences: row.dependencyReferences,
      satisfactionEvidence: row.satisfactionEvidence,
      disposition: row.disposition,
      sourceRevision: row.sourceRevision,
      correlationId: row.correlationId,
      dueAt: row.dueAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      satisfiedAt: row.satisfiedAt?.toISOString() ?? null,
    };
  }

  private toArtifactVersion(
    row: typeof schema.artifactVersions.$inferSelect,
    artifactType: string,
    artifactName: string,
    producedByRole: AgentRole | null,
  ): ArtifactVersionRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      artifactId: row.artifactId,
      artifactType,
      artifactName,
      producedByRole,
      version: row.version,
      status: row.status,
      content: row.content,
      mimeType: row.mimeType,
      contentHash: row.contentHash,
      storageUri: row.storageUri,
      repositoryPath: row.repositoryPath,
      sourceRevision: row.sourceRevision,
      supersedesVersionId: row.supersedesVersionId,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toFinding(
    row: typeof schema.findings.$inferSelect,
    raisedByRole: AgentRole | null,
    ownerRole: AgentRole | null,
  ): FindingRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      raisedByRole,
      ownerRole,
      obligationId: row.obligationId,
      actionId: row.actionId,
      artifactVersionId: row.artifactVersionId,
      category: row.category,
      title: row.title,
      description: row.description,
      severity: row.severity,
      status: row.status,
      disposition: row.disposition,
      subjectReferences: row.subjectReferences,
      evidenceReferences: row.evidenceReferences,
      sourceRevision: row.sourceRevision,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    };
  }

  private toModelInvocation(
    row: typeof schema.modelInvocations.$inferSelect,
    role: AgentRole | null,
  ): ModelInvocationRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      role,
      actionId: row.actionId,
      provider: row.provider,
      model: row.model,
      purpose: row.purpose,
      status: row.status,
      externalRequestId: row.externalRequestId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      totalTokens: row.totalTokens,
      costUsd: row.costUsd,
      requestMetadata: row.requestMetadata,
      responseMetadata: row.responseMetadata,
      error: row.error,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private toRepositoryOperation(
    row: typeof schema.repositoryOperations.$inferSelect,
    role: AgentRole | null,
  ): RepositoryOperationRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      role,
      actionId: row.actionId,
      lifecycleRecordId: row.lifecycleRecordId,
      type: row.type,
      status: row.status,
      mutating: row.mutating,
      repositoryUrl: row.repositoryUrl,
      branchName: row.branchName,
      paths: row.paths,
      expectedBaseRevision: row.expectedBaseRevision,
      resultingRevision: row.resultingRevision,
      externalId: row.externalId,
      summary: row.summary,
      metadata: row.metadata,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private toAgentRuntimeSnapshot(
    role: AgentRole,
    row: typeof schema.agentRuntimeStates.$inferSelect,
  ): AgentRuntimeSnapshot {
    return {
      role,
      state: row.state,
      activity: row.activityType && row.activitySummary
        ? { type: row.activityType, summary: row.activitySummary, startedAt: row.enteredAt.toISOString() }
        : null,
      stateChangedAt: row.enteredAt.toISOString(),
      mailboxDepth: 0,
      activeOrderCount: ['planning', 'working', 'reviewing', 'communicating'].includes(row.state) ? 1 : 0,
      blockerCount: row.blockerReferences.length + (row.state === 'blocked' && row.blockerReferences.length === 0 ? 1 : 0),
      pendingQuestionCount: row.state === 'waiting_on_human' ? 1 : 0,
      graphVersion: 1,
      stateVersion: row.stateVersion,
    };
  }

  private toAgentInteraction(
    row: typeof schema.agentMessages.$inferSelect,
    iterationNumber: number,
  ): AgentInteraction {
    const status: AgentInteraction['status'] = row.status === 'pending' || row.status === 'delivered'
      ? 'pending'
      : row.status === 'acknowledged' ? 'acknowledged'
        : row.status === 'completed' ? 'completed'
          : row.status === 'superseded' ? 'rejected' : 'blocked';
    return {
      id: row.id,
      messageId: row.protocolMessageId,
      correlationId: row.correlationId,
      iterationNumber,
      from: row.senderRole,
      to: row.recipientRoles,
      kind: row.type as AgentInteractionKind,
      name: row.name,
      summary: row.summary,
      status,
      createdAt: row.createdAt.toISOString(),
      priority: row.priority,
      requiresAcknowledgement: row.requiresAcknowledgement,
      deliveredAt: row.deliveredAt?.toISOString(),
      live: row.status === 'pending' || row.status === 'delivered',
    };
  }

  private toIterationReviewProposal(
    row: typeof schema.iterationReviewProposals.$inferSelect,
    iterationNumber: number,
  ): IterationReviewProposal {
    const positions = Object.fromEntries(organismAgentRoles.map((role) => {
      const value = row.agentPositions[role];
      const allowed = ['ready', 'ready_with_findings', 'ready_with_accepted_risk', 'not_ready', 'not_required'] as const;
      return [role, allowed.includes(value as (typeof allowed)[number]) ? value : 'not_required'];
    })) as IterationReviewProposal['agentPositions'];
    const findings = row.openFindings.flatMap((finding) => {
      if (!isRecord(finding)
        || typeof finding.summary !== 'string'
        || !['critical', 'high', 'medium', 'low', 'info'].includes(String(finding.severity))
        || !['resolve_in_iteration', 'accepted_risk', 'defer_to_next_iteration', 'human_decision_required'].includes(String(finding.disposition))) return [];
      return [{
        findingId: typeof finding.findingId === 'string' ? finding.findingId : undefined,
        severity: finding.severity as IterationReviewProposal['openFindings'][number]['severity'],
        summary: finding.summary,
        disposition: finding.disposition as IterationReviewProposal['openFindings'][number]['disposition'],
      }];
    });
    return {
      id: row.id,
      projectId: row.projectId,
      iterationId: row.iterationId,
      iterationNumber,
      type: 'iteration_review_proposal',
      proposalVersion: row.proposalVersion,
      status: row.status,
      objectiveStatus: row.objectiveStatus,
      includedRevision: row.includedRevision,
      completedOutcomes: row.completedOutcomes,
      openFindings: findings,
      agentPositions: positions,
      gateStatus: row.gateStatus === 'pass' ? 'pass' : 'blocked',
      gateRationale: row.gateRationale ?? 'Gate evidence was recorded at the iteration boundary.',
      managerRationale: row.managerRationale ?? 'Manager recorded the current Gate position and iteration boundary.',
      recommendation: row.recommendation,
      knownLimitations: row.knownLimitations,
      budgetSnapshot: {
        modelInvocationCount: numericLedgerValue(row.budgetSnapshot.modelInvocationCount),
        totalTokens: numericLedgerValue(row.budgetSnapshot.totalTokens),
        openRouterCostUsd: numericLedgerValue(row.budgetSnapshot.openRouterCostUsd),
        repositoryOperationCount: numericLedgerValue(row.budgetSnapshot.repositoryOperationCount),
        activeMutationCount: numericLedgerValue(row.budgetSnapshot.activeMutationCount),
      },
      createdAt: row.createdAt.toISOString(),
    };
  }

  private intentArtifact(brief: ProjectBrief) {
    return `# ${brief.name}\n\n## Desired outcome\n${brief.intent}\n\n## People served\n${brief.audience}\n\n## Success\n${brief.success}\n\n## Constraints\n${brief.constraints.map((item) => `- ${item}`).join('\n') || '- None supplied yet'}`;
  }
}

export {
  agentActionPlans,
  agentActions,
  agentComments,
  agentGoals,
  agentMessages,
  agentObligations,
  agentQuestionAnswers,
  agentQuestionOptions,
  agentQuestions,
  agentRuntimeStates,
  agents,
  artifactFeedback,
  artifactVersions,
  artifacts,
  findings,
  humanDecisions,
  humanFeedback,
  iterationAgentFeedback,
  iterationReviewProposals,
  iterationReviews,
  iterationWorkIssues,
  iterations,
  messageThreads,
  modelInvocations,
  projectEvents,
  projectMedia,
  projects,
  repositoryLifecycleRecords,
  repositoryOperations,
  temporalPayloads,
} from './schema.js';
