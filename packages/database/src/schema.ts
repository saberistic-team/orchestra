import type { AgentArtifactDraft, AgentRole, ModelProvider, RepositoryLifecycleKind } from '@orchestra/contracts';
import { relations, sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const projectStatuses = ['discovering', 'defining', 'planning', 'building', 'reviewing', 'awaiting_approval', 'blocked', 'completed'] as const;

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  intent: text('intent').notNull(),
  audience: text('audience').notNull(),
  success: text('success').notNull(),
  constraints: jsonb('constraints').$type<string[]>().notNull().default([]),
  status: text('status').$type<(typeof projectStatuses)[number]>().notNull().default('discovering'),
  currentIteration: integer('current_iteration').notNull().default(1),
  previewUrl: text('preview_url'),
  repositoryUrl: text('repository_url'),
  repositoryOwner: text('repository_owner'),
  repositoryName: text('repository_name'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const iterations = pgTable('project_iterations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  objective: text('objective').notNull(),
  status: text('status').$type<'active' | 'awaiting_review' | 'changes_requested' | 'approved' | 'completed' | 'blocked'>().notNull().default('active'),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  issueNumber: integer('issue_number'),
  branchName: text('branch_name'),
  pullRequestNumber: integer('pull_request_number'),
  pullRequestUrl: text('pull_request_url'),
}, (table) => [uniqueIndex('project_iteration_number').on(table.projectId, table.number)]);

export const projectEvents = pgTable('project_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationNumber: integer('iteration_number'),
  kind: text('kind').$type<'project' | 'agent' | 'artifact' | 'review' | 'deployment' | 'system'>().notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  agentRole: text('agent_role'),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [uniqueIndex('project_event_operation_key').on(table.projectId, table.operationKey)]);

export const artifacts = pgTable('project_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').notNull().references(() => iterations.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  content: text('content').notNull(),
  mimeType: text('mime_type').notNull().default('text/markdown'),
  status: text('status').$type<'draft' | 'ready_for_review' | 'changes_requested' | 'approved' | 'superseded'>().notNull().default('ready_for_review'),
  producedBy: text('produced_by').notNull(),
  model: text('model'),
  modelProvider: text('model_provider').$type<ModelProvider>(),
  modelInvocations: jsonb('model_invocations').$type<AgentArtifactDraft['modelInvocations']>(),
  repositoryPath: text('repository_path'),
  repositoryUrl: text('repository_url'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
});

export const projectMedia = pgTable('project_media', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  kind: text('kind').$type<'user_flow_video' | 'preview'>().notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  sourceRevision: text('source_revision'),
  imageDigest: text('image_digest'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const agentQuestions = pgTable('agent_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  agentRole: text('agent_role').$type<AgentRole>().notNull(),
  decisionKey: text('decision_key').notNull(),
  reusedFromQuestionId: uuid('reused_from_question_id'),
  question: text('question').notNull(),
  context: text('context'),
  status: text('status').$type<'pending' | 'answered' | 'dismissed'>().notNull().default('pending'),
  allowCustomAnswer: boolean('allow_custom_answer').notNull().default(true),
  allowAgentDecide: boolean('allow_agent_decide').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const agentQuestionOptions = pgTable('agent_question_options', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id').notNull().references(() => agentQuestions.id, { onDelete: 'cascade' }),
  value: text('value').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  position: integer('position').notNull(),
}, (table) => [
  uniqueIndex('agent_question_option_value').on(table.questionId, table.value),
  uniqueIndex('agent_question_option_position').on(table.questionId, table.position),
]);

export const agentQuestionAnswers = pgTable('agent_question_answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id').notNull().references(() => agentQuestions.id, { onDelete: 'cascade' }),
  resolution: text('resolution').$type<'selected_option' | 'custom' | 'agent_decides'>().notNull(),
  optionId: uuid('option_id').references(() => agentQuestionOptions.id, { onDelete: 'set null' }),
  answer: text('answer'),
  answeredBy: text('answered_by').$type<'human' | 'agent'>().notNull().default('human'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('agent_question_one_answer').on(table.questionId),
  check('agent_question_answer_shape', sql`
    (${table.resolution} = 'selected_option' AND ${table.optionId} IS NOT NULL AND ${table.answer} IS NULL)
    OR (${table.resolution} = 'custom' AND ${table.optionId} IS NULL AND length(${table.answer}) > 0)
    OR (${table.resolution} = 'agent_decides' AND ${table.optionId} IS NULL AND ${table.answer} IS NULL)
  `),
]);

export const agentComments = pgTable('agent_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  agentRole: text('agent_role').$type<AgentRole>().notNull(),
  body: text('body').notNull(),
  authorType: text('author_type').$type<'human' | 'agent' | 'system'>().notNull().default('human'),
  authorRole: text('author_role').$type<AgentRole>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const iterationReviews = pgTable('iteration_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').notNull().references(() => iterations.id, { onDelete: 'cascade' }),
  iterationNumber: integer('iteration_number').notNull(),
  decision: text('decision').$type<'approve' | 'request_changes'>().notNull(),
  feedback: text('feedback').notNull().default(''),
  overallDirection: text('overall_direction').notNull().default(''),
  previewRevision: text('preview_revision'),
  previewImageDigest: text('preview_image_digest'),
  previewTriedAt: timestamp('preview_tried_at', { withTimezone: true, mode: 'date' }),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('iteration_review_operation_key').on(table.projectId, table.operationKey),
  check('iteration_review_preview_attestation_shape_v2', sql`
    (${table.previewRevision} IS NULL AND ${table.previewImageDigest} IS NULL AND ${table.previewTriedAt} IS NULL)
    OR (${table.previewRevision} IS NOT NULL AND ${table.previewTriedAt} IS NOT NULL)
  `),
]);

export const iterationAgentFeedback = pgTable('iteration_agent_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id').notNull().references(() => iterationReviews.id, { onDelete: 'cascade' }),
  role: text('agent_role').$type<AgentRole>().notNull(),
  feedback: text('feedback').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [uniqueIndex('iteration_review_agent_role').on(table.reviewId, table.role)]);

export const artifactFeedback = pgTable('artifact_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').notNull().references(() => iterations.id, { onDelete: 'cascade' }),
  artifactId: uuid('artifact_id').notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
  reviewId: uuid('review_id').references(() => iterationReviews.id, { onDelete: 'set null' }),
  feedback: text('feedback').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const repositoryLifecycleRecords = pgTable('repository_lifecycle_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  kind: text('kind').$type<RepositoryLifecycleKind>().notNull(),
  status: text('status').$type<'pending' | 'completed' | 'failed'>().notNull(),
  repositoryUrl: text('repository_url'),
  externalId: text('external_id'),
  summary: text('summary').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [uniqueIndex('repository_lifecycle_operation_key').on(table.projectId, table.operationKey)]);

export const projectsRelations = relations(projects, ({ many }) => ({
  iterations: many(iterations),
  questions: many(agentQuestions),
  comments: many(agentComments),
  iterationReviews: many(iterationReviews),
  artifactFeedback: many(artifactFeedback),
  repositoryLifecycleRecords: many(repositoryLifecycleRecords),
}));

export const iterationsRelations = relations(iterations, ({ one, many }) => ({
  project: one(projects, { fields: [iterations.projectId], references: [projects.id] }),
  questions: many(agentQuestions),
  comments: many(agentComments),
  reviews: many(iterationReviews),
  artifactFeedback: many(artifactFeedback),
  repositoryLifecycleRecords: many(repositoryLifecycleRecords),
}));

export const agentQuestionsRelations = relations(agentQuestions, ({ one, many }) => ({
  project: one(projects, { fields: [agentQuestions.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [agentQuestions.iterationId], references: [iterations.id] }),
  options: many(agentQuestionOptions),
  answers: many(agentQuestionAnswers),
}));

export const agentQuestionOptionsRelations = relations(agentQuestionOptions, ({ one }) => ({
  question: one(agentQuestions, { fields: [agentQuestionOptions.questionId], references: [agentQuestions.id] }),
}));

export const agentQuestionAnswersRelations = relations(agentQuestionAnswers, ({ one }) => ({
  question: one(agentQuestions, { fields: [agentQuestionAnswers.questionId], references: [agentQuestions.id] }),
  option: one(agentQuestionOptions, { fields: [agentQuestionAnswers.optionId], references: [agentQuestionOptions.id] }),
}));

export const iterationReviewsRelations = relations(iterationReviews, ({ one, many }) => ({
  project: one(projects, { fields: [iterationReviews.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [iterationReviews.iterationId], references: [iterations.id] }),
  agentFeedback: many(iterationAgentFeedback),
  artifactFeedback: many(artifactFeedback),
}));

export const iterationAgentFeedbackRelations = relations(iterationAgentFeedback, ({ one }) => ({
  review: one(iterationReviews, { fields: [iterationAgentFeedback.reviewId], references: [iterationReviews.id] }),
}));

export const artifactFeedbackRelations = relations(artifactFeedback, ({ one }) => ({
  project: one(projects, { fields: [artifactFeedback.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [artifactFeedback.iterationId], references: [iterations.id] }),
  artifact: one(artifacts, { fields: [artifactFeedback.artifactId], references: [artifacts.id] }),
  review: one(iterationReviews, { fields: [artifactFeedback.reviewId], references: [iterationReviews.id] }),
}));

export const agentCommentsRelations = relations(agentComments, ({ one }) => ({
  project: one(projects, { fields: [agentComments.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [agentComments.iterationId], references: [iterations.id] }),
}));

export const repositoryLifecycleRecordsRelations = relations(repositoryLifecycleRecords, ({ one }) => ({
  project: one(projects, { fields: [repositoryLifecycleRecords.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [repositoryLifecycleRecords.iterationId], references: [iterations.id] }),
}));
