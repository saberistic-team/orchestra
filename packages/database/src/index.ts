import {
  organismAgentRoles,
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
  type IterationReview,
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
  type RepositoryLifecycleInput,
  type RepositoryLifecycleRecord,
} from '@orchestra/contracts';
import { and, count, desc, eq, inArray, max } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

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

  async create(brief: ProjectBrief): Promise<Project> {
    const row = await this.database.transaction(async (transaction) => {
      const [project] = await transaction.insert(schema.projects).values(brief).returning();
      const [iteration] = await transaction.insert(schema.iterations).values({
        projectId: project.id,
        number: 1,
        objective: 'Turn the initial intent into an approved, testable first increment.',
      }).returning();
      await transaction.insert(schema.artifacts).values({
        projectId: project.id,
        iterationId: iteration.id,
        type: 'project-intent',
        name: 'Project intent',
        content: this.intentArtifact(brief),
        mimeType: 'text/markdown',
        producedBy: 'manager',
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
    const [iterationRows, eventRows, artifactRows, mediaRows, questions, agentComments, artifactFeedback, iterationReviews] = await Promise.all([
      this.database.select().from(schema.iterations).where(eq(schema.iterations.projectId, id)).orderBy(desc(schema.iterations.number)),
      this.database.select().from(schema.projectEvents).where(eq(schema.projectEvents.projectId, id)).orderBy(desc(schema.projectEvents.createdAt)),
      this.database.select().from(schema.artifacts).where(eq(schema.artifacts.projectId, id)).orderBy(desc(schema.artifacts.createdAt)),
      this.database.select().from(schema.projectMedia).where(eq(schema.projectMedia.projectId, id)).orderBy(desc(schema.projectMedia.createdAt)),
      this.listAgentQuestions(id),
      this.listAgentComments(id),
      this.listArtifactFeedback(id),
      this.listIterationReviews(id),
    ]);
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
    };
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
      await transaction.insert(schema.repositoryLifecycleRecords).values({
        projectId,
        kind: 'repository_connected',
        status: 'completed',
        repositoryUrl: repository.url,
        externalId: `${repository.owner}/${repository.name}`,
        summary: `Connected repository ${repository.owner}/${repository.name}.`,
        metadata: { owner: repository.owner, name: repository.name },
      });
      return updated;
    });
    return this.toContract(row);
  }

  async updateIterationDelivery(iterationId: string, delivery: {
    issueNumber?: number;
    branchName?: string;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
  }): Promise<ProjectIteration> {
    const [row] = await this.database.update(schema.iterations).set(delivery)
      .where(eq(schema.iterations.id, iterationId)).returning();
    const [project] = await this.database.select().from(schema.projects)
      .where(eq(schema.projects.id, row.projectId)).limit(1);
    const records: Array<typeof schema.repositoryLifecycleRecords.$inferInsert> = [];
    if (delivery.issueNumber !== undefined) {
      records.push({
        projectId: row.projectId,
        iterationId: row.id,
        kind: 'issue_created',
        status: 'completed',
        repositoryUrl: project?.repositoryUrl,
        externalId: String(delivery.issueNumber),
        summary: `Repository issue #${delivery.issueNumber} is linked to iteration ${row.number}.`,
      });
    }
    if (delivery.branchName !== undefined) {
      records.push({
        projectId: row.projectId,
        iterationId: row.id,
        kind: 'branch_created',
        status: 'completed',
        repositoryUrl: project?.repositoryUrl,
        externalId: delivery.branchName,
        summary: `Branch ${delivery.branchName} is linked to iteration ${row.number}.`,
      });
    }
    if (delivery.pullRequestNumber !== undefined || delivery.pullRequestUrl !== undefined) {
      records.push({
        projectId: row.projectId,
        iterationId: row.id,
        kind: 'pull_request_opened',
        status: 'completed',
        repositoryUrl: project?.repositoryUrl,
        externalId: delivery.pullRequestNumber === undefined ? delivery.pullRequestUrl : String(delivery.pullRequestNumber),
        summary: `A pull request is linked to iteration ${row.number}.`,
        metadata: delivery.pullRequestUrl ? { pullRequestUrl: delivery.pullRequestUrl } : {},
      });
    }
    if (records.length > 0) await this.database.insert(schema.repositoryLifecycleRecords).values(records);
    return this.toIteration(row);
  }

  async addEvent(
    input: Omit<ProjectEvent, 'id' | 'createdAt'>,
    operationKey?: string,
  ): Promise<ProjectEvent> {
    if (operationKey) {
      const [existing] = await this.database.select().from(schema.projectEvents).where(and(
        eq(schema.projectEvents.projectId, input.projectId),
        eq(schema.projectEvents.operationKey, operationKey),
      )).limit(1);
      if (existing) return this.toEvent(existing);
    }
    const [row] = await this.database.insert(schema.projectEvents).values({
      ...input,
      operationKey: operationKey ?? null,
    }).returning();
    await this.database.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
    return this.toEvent(row);
  }

  async addArtifact(projectId: string, iterationId: string, draft: AgentArtifactDraft, iterationNumber: number | null = null): Promise<ProjectArtifact> {
    const [{ value }] = await this.database.select({ value: max(schema.artifacts.version) }).from(schema.artifacts)
      .where(and(eq(schema.artifacts.projectId, projectId), eq(schema.artifacts.type, draft.type)));
    const [row] = await this.database.insert(schema.artifacts).values({
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
    }).returning();
    await this.addEvent({
      projectId,
      iterationNumber,
      kind: 'artifact',
      title: `${draft.name} is ready`,
      description: `${draft.producedBy} produced version ${(value ?? 0) + 1} for review.`,
      agentRole: draft.producedBy,
    });
    return this.toArtifact(row);
  }

  async locateArtifact(artifactId: string, repositoryPath: string, repositoryUrl: string): Promise<ProjectArtifact> {
    const [row] = await this.database.update(schema.artifacts).set({ repositoryPath, repositoryUrl })
      .where(eq(schema.artifacts.id, artifactId)).returning();
    return this.toArtifact(row);
  }

  async addMedia(input: AddProjectMediaInput): Promise<ProjectMedia> {
    const {
      sourceRevision = null,
      imageDigest = null,
      expiresAt = null,
      ...media
    } = input;
    const expiration = expiresAt === null ? null : new Date(expiresAt);
    if (expiration && Number.isNaN(expiration.getTime())) throw new Error('Preview media expiresAt must be a valid timestamp.');
    const [row] = await this.database.insert(schema.projectMedia).values({
      ...media,
      sourceRevision,
      imageDigest,
      expiresAt: expiration,
    }).returning();
    await this.database.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
    return this.toMedia(row);
  }

  async addAgentQuestion(input: AgentQuestionInput): Promise<AgentQuestion> {
    const questionId = await this.database.transaction(async (transaction) => {
      const [question] = await transaction.insert(schema.agentQuestions).values({
        projectId: input.projectId,
        iterationId: input.iterationId ?? null,
        agentRole: input.agentRole,
        decisionKey: canonicalDecisionKey(input),
        question: input.question,
        context: input.context ?? null,
        allowCustomAnswer: input.allowCustomAnswer,
        allowAgentDecide: input.allowAgentDecide,
      }).returning({ id: schema.agentQuestions.id });
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

      if (input.resolution === 'selected_option') {
        const [option] = await transaction.select().from(schema.agentQuestionOptions)
          .where(and(
            eq(schema.agentQuestionOptions.id, input.optionId),
            eq(schema.agentQuestionOptions.questionId, questionId),
          )).limit(1);
        if (!option) throw new Error('The selected option does not belong to this question.');
        await transaction.insert(schema.agentQuestionAnswers).values({
          questionId,
          resolution: input.resolution,
          optionId: input.optionId,
          answeredBy,
        });
      } else if (input.resolution === 'custom') {
        if (!question.allowCustomAnswer) throw new Error('This question does not allow a custom answer.');
        await transaction.insert(schema.agentQuestionAnswers).values({
          questionId,
          resolution: input.resolution,
          answer: input.answer,
          answeredBy,
        });
      } else {
        if (!question.allowAgentDecide) throw new Error('This question does not allow the agent to decide.');
        await transaction.insert(schema.agentQuestionAnswers).values({
          questionId,
          resolution: input.resolution,
          answeredBy,
        });
      }

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
    const [row] = await this.database.insert(schema.agentComments).values({
      projectId: input.projectId,
      iterationId: input.iterationId ?? null,
      agentRole: input.agentRole,
      body: input.body,
      authorType: input.authorType,
      authorRole: input.authorRole ?? null,
    }).returning();
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
    const [row] = await this.database.insert(schema.artifactFeedback).values({
      projectId: artifact.projectId,
      iterationId: artifact.iterationId,
      artifactId: artifact.id,
      reviewId,
      feedback: input.feedback,
    }).returning();
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
    if (operationKey) {
      const [existing] = await this.database.select().from(schema.repositoryLifecycleRecords).where(and(
        eq(schema.repositoryLifecycleRecords.projectId, input.projectId),
        eq(schema.repositoryLifecycleRecords.operationKey, operationKey),
      )).limit(1);
      if (existing) return this.toRepositoryLifecycle(existing);
    }
    const [row] = await this.database.insert(schema.repositoryLifecycleRecords).values({
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
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction.update(schema.iterations).set({
        status: approved ? 'approved' : 'changes_requested',
        completedAt: null,
      }).where(eq(schema.iterations.id, iteration.id));
      await transaction.update(schema.artifacts).set({
        status: approved ? 'ready_for_review' : 'changes_requested',
        reviewedAt: now,
      }).where(eq(schema.artifacts.iterationId, iteration.id));
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
      }).returning({ id: schema.iterationReviews.id });
      await transaction.insert(schema.iterationAgentFeedback).values(organismAgentRoles.map((role) => ({
        reviewId: reviewRow.id,
        role,
        feedback: suppliedAgentFeedback.get(role) ?? '',
        createdAt: now,
      })));

      const artifactFeedbackInputs = review.artifactFeedback ?? [];
      if (artifactFeedbackInputs.length > 0) {
        const artifactIds = [...new Set(artifactFeedbackInputs.map((entry) => entry.artifactId))];
        const artifactRows = await transaction.select().from(schema.artifacts)
          .where(and(
            eq(schema.artifacts.iterationId, iteration.id),
            inArray(schema.artifacts.id, artifactIds),
          ));
        const artifactsById = new Map(artifactRows.map((artifact) => [artifact.id, artifact]));
        for (const feedback of artifactFeedbackInputs) {
          const artifact = artifactsById.get(feedback.artifactId);
          if (!artifact) throw new Error(`Artifact ${feedback.artifactId} does not belong to iteration ${iterationNumber}.`);
          await transaction.insert(schema.artifactFeedback).values({
            projectId,
            iterationId: iteration.id,
            artifactId: artifact.id,
            reviewId: reviewRow.id,
            feedback: feedback.feedback,
            createdAt: now,
          });
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
        await transaction.insert(schema.repositoryLifecycleRecords).values({
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
      }).where(eq(schema.artifacts.iterationId, iteration.id));
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
    return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  private toIteration(row: typeof schema.iterations.$inferSelect): ProjectIteration {
    return { ...row, startedAt: row.startedAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null };
  }

  private toEvent(row: typeof schema.projectEvents.$inferSelect): ProjectEvent {
    return { ...row, agentRole: row.agentRole as AgentRole | null, createdAt: row.createdAt.toISOString() };
  }

  private toArtifact(row: typeof schema.artifacts.$inferSelect): ProjectArtifact {
    return {
      ...row,
      producedBy: row.producedBy as AgentRole,
      mimeType: row.mimeType,
      modelInvocations: row.modelInvocations ?? undefined,
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

  private intentArtifact(brief: ProjectBrief) {
    return `# ${brief.name}\n\n## Desired outcome\n${brief.intent}\n\n## People served\n${brief.audience}\n\n## Success\n${brief.success}\n\n## Constraints\n${brief.constraints.map((item) => `- ${item}`).join('\n') || '- None supplied yet'}`;
  }
}

export {
  agentComments,
  agentQuestionAnswers,
  agentQuestionOptions,
  agentQuestions,
  artifactFeedback,
  artifacts,
  iterationAgentFeedback,
  iterationReviews,
  iterations,
  projectEvents,
  projectMedia,
  projects,
  repositoryLifecycleRecords,
} from './schema.js';
