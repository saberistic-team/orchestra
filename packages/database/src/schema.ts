import type { AgentArtifactDraft, AgentRole, ModelProvider, RepositoryLifecycleKind } from '@orchestra/contracts';
import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const projectStatuses = ['discovering', 'defining', 'planning', 'building', 'reviewing', 'awaiting_approval', 'blocked', 'completed'] as const;

export const agentLifecycleStatuses = ['active', 'paused', 'retired'] as const;
export const agentRuntimeStateKinds = [
  'observing',
  'ready',
  'planning',
  'working',
  'reviewing',
  'communicating',
  'waiting_on_agent',
  'waiting_on_human',
  'monitoring',
  'blocked',
  'completed_for_iteration',
] as const;
export const agentPriorityKinds = ['low', 'normal', 'high', 'critical'] as const;
export const agentGoalStatuses = ['active', 'satisfied', 'blocked', 'abandoned', 'superseded'] as const;
export const agentActionPlanStatuses = ['draft', 'active', 'completed', 'blocked', 'superseded', 'cancelled'] as const;
export const agentActionStatuses = ['pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'superseded'] as const;
export const messageThreadStatuses = ['open', 'resolved', 'archived'] as const;
export const agentMessageTypes = [
  'order',
  'request',
  'question',
  'answer',
  'finding',
  'decision',
  'handoff',
  'evidence',
  'review',
  'status',
  'acknowledgement',
  'blocker',
  'revision_request',
  'review_proposal',
] as const;
export const agentMessageStatuses = ['pending', 'delivered', 'acknowledged', 'completed', 'failed', 'superseded'] as const;
export const agentObligationStatuses = ['pending', 'ready', 'in_progress', 'blocked', 'satisfied', 'waived', 'deferred', 'failed'] as const;
export const findingSeverities = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const findingStatuses = ['open', 'acknowledged', 'remediating', 'resolved', 'accepted_risk', 'dismissed'] as const;
export const findingDispositions = ['block_iteration', 'remediate_current', 'defer_to_next_iteration', 'accepted_risk', 'not_applicable'] as const;
export const humanDecisionStatuses = ['recorded', 'superseded', 'revoked'] as const;
export const humanFeedbackStatuses = ['received', 'acknowledged', 'addressed', 'dismissed'] as const;
export const modelInvocationStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const repositoryOperationStatuses = ['queued', 'running', 'completed', 'failed', 'conflicted', 'cancelled'] as const;
export const iterationReviewProposalStatuses = ['draft', 'proposed', 'gate_blocked', 'superseded', 'accepted', 'rejected'] as const;

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

export const temporalPayloadBlobs = pgTable('temporal_payload_blobs', {
  digest: text('digest').primaryKey(),
  dataBase64: text('data_base64').notNull(),
  metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
  byteLength: integer('byte_length').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  check('temporal_payload_blobs_byte_length_nonnegative', sql`${table.byteLength} >= 0`),
]);

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
  executionTrace: jsonb('execution_trace').$type<AgentArtifactDraft['executionTrace']>(),
  operationKey: text('operation_key'),
  operationManifestHash: text('operation_manifest_hash'),
  operationPayload: jsonb('operation_payload').$type<AgentArtifactDraft>(),
  storageMode: text('storage_mode').$type<'repository' | 'ledger'>().notNull().default('repository'),
  repositoryPath: text('repository_path'),
  repositoryUrl: text('repository_url'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [uniqueIndex('project_artifact_operation_key').on(table.projectId, table.operationKey)]);

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
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [uniqueIndex('project_media_operation_key').on(table.projectId, table.operationKey)]);

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
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('agent_question_operation_key').on(table.projectId, table.operationKey),
]);

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

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  role: text('role').$type<AgentRole>().notNull(),
  workflowId: text('workflow_id').notNull(),
  instanceId: text('instance_id'),
  lifecycleStatus: text('lifecycle_status').$type<(typeof agentLifecycleStatuses)[number]>().notNull().default('active'),
  subscriptions: jsonb('subscriptions').$type<string[]>().notNull().default([]),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('agents_project_role').on(table.projectId, table.role),
  uniqueIndex('agents_project_workflow').on(table.projectId, table.workflowId),
  index('agents_project_lifecycle').on(table.projectId, table.lifecycleStatus),
  check('agents_role_check', sql`${table.role} IN (
    'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
    'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation'
  )`),
  check('agents_lifecycle_status_check', sql`${table.lifecycleStatus} IN ('active', 'paused', 'retired')`),
  check('agents_subscriptions_array_check', sql`jsonb_typeof(${table.subscriptions}) = 'array'`),
  check('agents_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
]);

export const agentRuntimeStates = pgTable('agent_runtime_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  state: text('state').$type<(typeof agentRuntimeStateKinds)[number]>().notNull(),
  stateVersion: integer('state_version').notNull(),
  activityType: text('activity_type'),
  activitySummary: text('activity_summary'),
  waitingReason: text('waiting_reason'),
  blockerReferences: jsonb('blocker_references').$type<string[]>().notNull().default([]),
  modelProvider: text('model_provider').$type<ModelProvider>(),
  model: text('model'),
  workflowRunId: text('workflow_run_id'),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  enteredAt: timestamp('entered_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  exitedAt: timestamp('exited_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('agent_runtime_state_version').on(table.agentId, table.stateVersion),
  uniqueIndex('agent_runtime_state_current').on(table.agentId).where(sql`${table.exitedAt} IS NULL`),
  uniqueIndex('agent_runtime_state_operation_key').on(table.projectId, table.operationKey),
  index('agent_runtime_state_project_iteration').on(table.projectId, table.iterationId, table.enteredAt),
  index('agent_runtime_state_correlation').on(table.projectId, table.correlationId),
  check('agent_runtime_state_kind_check', sql`${table.state} IN (
    'observing', 'ready', 'planning', 'working', 'reviewing', 'communicating',
    'waiting_on_agent', 'waiting_on_human', 'monitoring', 'blocked', 'completed_for_iteration'
  )`),
  check('agent_runtime_state_version_check', sql`${table.stateVersion} >= 0`),
  check('agent_runtime_state_time_check', sql`${table.exitedAt} IS NULL OR ${table.exitedAt} >= ${table.enteredAt}`),
  check('agent_runtime_state_blockers_array_check', sql`jsonb_typeof(${table.blockerReferences}) = 'array'`),
]);

export const agentGoals = pgTable('agent_goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  objective: text('objective').notNull(),
  status: text('status').$type<(typeof agentGoalStatuses)[number]>().notNull().default('active'),
  priority: text('priority').$type<(typeof agentPriorityKinds)[number]>().notNull().default('normal'),
  successCriteria: jsonb('success_criteria').$type<string[]>().notNull().default([]),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('agent_goal_operation_key').on(table.projectId, table.operationKey),
  index('agent_goal_agent_status').on(table.agentId, table.status, table.updatedAt),
  index('agent_goal_iteration_status').on(table.projectId, table.iterationId, table.status),
  check('agent_goal_status_check', sql`${table.status} IN ('active', 'satisfied', 'blocked', 'abandoned', 'superseded')`),
  check('agent_goal_priority_check', sql`${table.priority} IN ('low', 'normal', 'high', 'critical')`),
  check('agent_goal_success_criteria_array_check', sql`jsonb_typeof(${table.successCriteria}) = 'array'`),
  check('agent_goal_time_check', sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}`),
]);

export const agentActionPlans = pgTable('agent_action_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  goalId: uuid('goal_id').references(() => agentGoals.id, { onDelete: 'set null' }),
  version: integer('version').notNull().default(1),
  summary: text('summary').notNull(),
  rationale: text('rationale'),
  status: text('status').$type<(typeof agentActionPlanStatuses)[number]>().notNull().default('draft'),
  sourceRevision: text('source_revision'),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('agent_action_plan_goal_version').on(table.goalId, table.version),
  uniqueIndex('agent_action_plan_operation_key').on(table.projectId, table.operationKey),
  index('agent_action_plan_agent_status').on(table.agentId, table.status, table.updatedAt),
  index('agent_action_plan_iteration_status').on(table.projectId, table.iterationId, table.status),
  check('agent_action_plan_version_check', sql`${table.version} > 0`),
  check('agent_action_plan_status_check', sql`${table.status} IN ('draft', 'active', 'completed', 'blocked', 'superseded', 'cancelled')`),
  check('agent_action_plan_time_check', sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}`),
]);

export const agentActions = pgTable('agent_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id').references(() => agentActionPlans.id, { onDelete: 'set null' }),
  position: integer('position').notNull(),
  kind: text('kind').notNull(),
  summary: text('summary').notNull(),
  status: text('status').$type<(typeof agentActionStatuses)[number]>().notNull().default('pending'),
  blocking: boolean('blocking').notNull().default(false),
  dependencyActionIds: jsonb('dependency_action_ids').$type<string[]>().notNull().default([]),
  input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
  output: jsonb('output').$type<Record<string, unknown>>(),
  error: text('error'),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('agent_action_plan_position').on(table.planId, table.position),
  uniqueIndex('agent_action_operation_key').on(table.projectId, table.operationKey),
  index('agent_action_agent_status').on(table.agentId, table.status, table.updatedAt),
  index('agent_action_iteration_status').on(table.projectId, table.iterationId, table.status),
  index('agent_action_correlation').on(table.projectId, table.correlationId),
  check('agent_action_position_check', sql`${table.position} >= 0`),
  check('agent_action_status_check', sql`${table.status} IN ('pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'superseded')`),
  check('agent_action_dependencies_array_check', sql`jsonb_typeof(${table.dependencyActionIds}) = 'array'`),
  check('agent_action_input_object_check', sql`jsonb_typeof(${table.input}) = 'object'`),
  check('agent_action_output_object_check', sql`${table.output} IS NULL OR jsonb_typeof(${table.output}) = 'object'`),
  check('agent_action_time_check', sql`${table.completedAt} IS NULL OR (${table.startedAt} IS NOT NULL AND ${table.completedAt} >= ${table.startedAt})`),
]);

export const messageThreads = pgTable('message_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  correlationId: text('correlation_id').notNull(),
  topic: text('topic').notNull(),
  status: text('status').$type<(typeof messageThreadStatuses)[number]>().notNull().default('open'),
  maxResponseDepth: integer('max_response_depth').notNull().default(8),
  responseCount: integer('response_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('message_thread_project_correlation').on(table.projectId, table.correlationId),
  index('message_thread_iteration_status').on(table.projectId, table.iterationId, table.status, table.updatedAt),
  check('message_thread_status_check', sql`${table.status} IN ('open', 'resolved', 'archived')`),
  check('message_thread_depth_check', sql`${table.maxResponseDepth} > 0 AND ${table.responseCount} >= 0`),
  check('message_thread_time_check', sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.createdAt}`),
]);

export const agentMessages = pgTable('agent_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  protocolMessageId: text('protocol_message_id').notNull(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  threadId: uuid('thread_id').notNull().references(() => messageThreads.id, { onDelete: 'cascade' }),
  senderAgentId: uuid('sender_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  senderRole: text('sender_role').$type<AgentRole | 'human' | 'system'>().notNull(),
  recipientRoles: jsonb('recipient_roles').$type<Array<AgentRole | 'human' | 'system'>>().notNull(),
  type: text('type').$type<(typeof agentMessageTypes)[number]>().notNull(),
  name: text('name').notNull(),
  summary: text('summary').notNull(),
  status: text('status').$type<(typeof agentMessageStatuses)[number]>().notNull().default('pending'),
  priority: text('priority').$type<(typeof agentPriorityKinds)[number]>().notNull().default('normal'),
  correlationId: text('correlation_id').notNull(),
  causationMessageId: uuid('causation_message_id').references((): AnyPgColumn => agentMessages.id, { onDelete: 'set null' }),
  responseDepth: integer('response_depth').notNull().default(0),
  idempotencyKey: text('idempotency_key').notNull(),
  requiresAcknowledgement: boolean('requires_acknowledgement').notNull().default(false),
  deliveryStates: jsonb('delivery_states').$type<Record<string, unknown>>().notNull().default({}),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  artifactReferences: jsonb('artifact_references').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('agent_message_protocol_id').on(table.projectId, table.protocolMessageId),
  uniqueIndex('agent_message_idempotency_key').on(table.projectId, table.idempotencyKey),
  index('agent_message_thread_created').on(table.threadId, table.createdAt),
  index('agent_message_project_status').on(table.projectId, table.status, table.availableAt),
  index('agent_message_iteration_type').on(table.projectId, table.iterationId, table.type, table.createdAt),
  index('agent_message_sender_created').on(table.senderAgentId, table.createdAt),
  index('agent_message_correlation').on(table.projectId, table.correlationId, table.createdAt),
  index('agent_message_recipients').using('gin', table.recipientRoles),
  check('agent_message_sender_check', sql`${table.senderRole} IN (
    'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
    'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation', 'human', 'system'
  )`),
  check('agent_message_recipients_check', sql`jsonb_typeof(${table.recipientRoles}) = 'array' AND jsonb_array_length(${table.recipientRoles}) > 0`),
  check('agent_message_type_check', sql`${table.type} IN (
    'order', 'request', 'question', 'answer', 'finding', 'decision', 'handoff',
    'evidence', 'review', 'status', 'acknowledgement', 'blocker', 'revision_request', 'review_proposal'
  )`),
  check('agent_message_status_check', sql`${table.status} IN ('pending', 'delivered', 'acknowledged', 'completed', 'failed', 'superseded')`),
  check('agent_message_priority_check', sql`${table.priority} IN ('low', 'normal', 'high', 'critical')`),
  check('agent_message_response_depth_check', sql`${table.responseDepth} >= 0`),
  check('agent_message_delivery_states_object_check', sql`jsonb_typeof(${table.deliveryStates}) = 'object'`),
  check('agent_message_payload_object_check', sql`jsonb_typeof(${table.payload}) = 'object'`),
  check('agent_message_artifacts_array_check', sql`jsonb_typeof(${table.artifactReferences}) = 'array'`),
  check('agent_message_time_check', sql`
    (${table.deliveredAt} IS NULL OR ${table.deliveredAt} >= ${table.createdAt})
    AND (${table.acknowledgedAt} IS NULL OR ${table.acknowledgedAt} >= ${table.createdAt})
    AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})
    AND (${table.expiresAt} IS NULL OR ${table.expiresAt} >= ${table.createdAt})
  `),
]);

export const agentObligations = pgTable('agent_obligations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  ownerAgentId: uuid('owner_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  goalId: uuid('goal_id').references(() => agentGoals.id, { onDelete: 'set null' }),
  actionId: uuid('action_id').references(() => agentActions.id, { onDelete: 'set null' }),
  type: text('type').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: text('status').$type<(typeof agentObligationStatuses)[number]>().notNull().default('pending'),
  priority: text('priority').$type<(typeof agentPriorityKinds)[number]>().notNull().default('normal'),
  mandatory: boolean('mandatory').notNull().default(true),
  blocking: boolean('blocking').notNull().default(true),
  subjectReferences: jsonb('subject_references').$type<string[]>().notNull().default([]),
  dependencyReferences: jsonb('dependency_references').$type<string[]>().notNull().default([]),
  satisfactionEvidence: jsonb('satisfaction_evidence').$type<string[]>().notNull().default([]),
  disposition: text('disposition'),
  sourceRevision: text('source_revision'),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  satisfiedAt: timestamp('satisfied_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('agent_obligation_operation_key').on(table.projectId, table.operationKey),
  index('agent_obligation_iteration_status').on(table.projectId, table.iterationId, table.status, table.blocking),
  index('agent_obligation_owner_status').on(table.ownerAgentId, table.status, table.updatedAt),
  index('agent_obligation_revision').on(table.projectId, table.sourceRevision),
  check('agent_obligation_status_check', sql`${table.status} IN ('pending', 'ready', 'in_progress', 'blocked', 'satisfied', 'waived', 'deferred', 'failed')`),
  check('agent_obligation_priority_check', sql`${table.priority} IN ('low', 'normal', 'high', 'critical')`),
  check('agent_obligation_subjects_array_check', sql`jsonb_typeof(${table.subjectReferences}) = 'array'`),
  check('agent_obligation_dependencies_array_check', sql`jsonb_typeof(${table.dependencyReferences}) = 'array'`),
  check('agent_obligation_evidence_array_check', sql`jsonb_typeof(${table.satisfactionEvidence}) = 'array'`),
  check('agent_obligation_time_check', sql`${table.satisfiedAt} IS NULL OR ${table.satisfiedAt} >= ${table.createdAt}`),
]);

export const artifactVersions = pgTable('artifact_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').notNull().references(() => iterations.id, { onDelete: 'cascade' }),
  artifactId: uuid('artifact_id').notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
  producedByAgentId: uuid('produced_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  version: integer('version').notNull(),
  status: text('status').$type<'draft' | 'ready_for_review' | 'changes_requested' | 'approved' | 'superseded'>().notNull(),
  content: text('content').notNull(),
  mimeType: text('mime_type').notNull().default('text/markdown'),
  contentHash: text('content_hash'),
  storageUri: text('storage_uri'),
  repositoryPath: text('repository_path'),
  sourceRevision: text('source_revision'),
  supersedesVersionId: uuid('supersedes_version_id').references((): AnyPgColumn => artifactVersions.id, { onDelete: 'set null' }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('artifact_version_number').on(table.artifactId, table.version),
  uniqueIndex('artifact_version_operation_key').on(table.projectId, table.operationKey),
  index('artifact_version_iteration_status').on(table.projectId, table.iterationId, table.status),
  index('artifact_version_source_revision').on(table.projectId, table.sourceRevision),
  index('artifact_version_content_hash').on(table.projectId, table.contentHash),
  check('artifact_version_number_check', sql`${table.version} > 0`),
  check('artifact_version_status_check', sql`${table.status} IN ('draft', 'ready_for_review', 'changes_requested', 'approved', 'superseded')`),
  check('artifact_version_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
]);

export const findings = pgTable('findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  raisedByAgentId: uuid('raised_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  ownerAgentId: uuid('owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  obligationId: uuid('obligation_id').references(() => agentObligations.id, { onDelete: 'set null' }),
  actionId: uuid('action_id').references(() => agentActions.id, { onDelete: 'set null' }),
  artifactVersionId: uuid('artifact_version_id').references(() => artifactVersions.id, { onDelete: 'set null' }),
  category: text('category').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  severity: text('severity').$type<(typeof findingSeverities)[number]>().notNull(),
  status: text('status').$type<(typeof findingStatuses)[number]>().notNull().default('open'),
  disposition: text('disposition').$type<(typeof findingDispositions)[number]>(),
  subjectReferences: jsonb('subject_references').$type<string[]>().notNull().default([]),
  evidenceReferences: jsonb('evidence_references').$type<string[]>().notNull().default([]),
  sourceRevision: text('source_revision'),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('finding_operation_key').on(table.projectId, table.operationKey),
  index('finding_iteration_status_severity').on(table.projectId, table.iterationId, table.status, table.severity),
  index('finding_owner_status').on(table.ownerAgentId, table.status, table.updatedAt),
  index('finding_revision').on(table.projectId, table.sourceRevision),
  index('finding_correlation').on(table.projectId, table.correlationId),
  check('finding_severity_check', sql`${table.severity} IN ('critical', 'high', 'medium', 'low', 'info')`),
  check('finding_status_check', sql`${table.status} IN ('open', 'acknowledged', 'remediating', 'resolved', 'accepted_risk', 'dismissed')`),
  check('finding_disposition_check', sql`${table.disposition} IS NULL OR ${table.disposition} IN ('block_iteration', 'remediate_current', 'defer_to_next_iteration', 'accepted_risk', 'not_applicable')`),
  check('finding_subjects_array_check', sql`jsonb_typeof(${table.subjectReferences}) = 'array'`),
  check('finding_evidence_array_check', sql`jsonb_typeof(${table.evidenceReferences}) = 'array'`),
  check('finding_time_check', sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.createdAt}`),
]);

export const humanDecisions = pgTable('human_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  questionId: uuid('question_id').references(() => agentQuestions.id, { onDelete: 'set null' }),
  reviewId: uuid('review_id').references(() => iterationReviews.id, { onDelete: 'set null' }),
  decisionKey: text('decision_key').notNull(),
  decisionType: text('decision_type').notNull(),
  selectedOption: text('selected_option').notNull(),
  rationale: text('rationale').notNull().default(''),
  decidedBy: text('decided_by').notNull(),
  status: text('status').$type<(typeof humanDecisionStatuses)[number]>().notNull().default('recorded'),
  optionsConsidered: jsonb('options_considered').$type<string[]>().notNull().default([]),
  appliesTo: jsonb('applies_to').$type<string[]>().notNull().default([]),
  authority: jsonb('authority').$type<Record<string, unknown>>().notNull().default({}),
  supersedesDecisionId: uuid('supersedes_decision_id').references((): AnyPgColumn => humanDecisions.id, { onDelete: 'set null' }),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  supersededAt: timestamp('superseded_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('human_decision_operation_key').on(table.projectId, table.operationKey),
  index('human_decision_key_created').on(table.projectId, table.decisionKey, table.createdAt),
  index('human_decision_iteration_status').on(table.projectId, table.iterationId, table.status),
  index('human_decision_correlation').on(table.projectId, table.correlationId),
  check('human_decision_status_check', sql`${table.status} IN ('recorded', 'superseded', 'revoked')`),
  check('human_decision_options_array_check', sql`jsonb_typeof(${table.optionsConsidered}) = 'array'`),
  check('human_decision_applies_to_array_check', sql`jsonb_typeof(${table.appliesTo}) = 'array'`),
  check('human_decision_authority_object_check', sql`jsonb_typeof(${table.authority}) = 'object'`),
  check('human_decision_time_check', sql`${table.supersededAt} IS NULL OR ${table.supersededAt} >= ${table.createdAt}`),
]);

export const humanFeedback = pgTable('human_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  decisionId: uuid('decision_id').references(() => humanDecisions.id, { onDelete: 'set null' }),
  reviewId: uuid('review_id').references(() => iterationReviews.id, { onDelete: 'set null' }),
  artifactId: uuid('artifact_id').references(() => artifacts.id, { onDelete: 'set null' }),
  artifactVersionId: uuid('artifact_version_id').references(() => artifactVersions.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  type: text('type').notNull(),
  body: text('body').notNull(),
  authorId: text('author_id'),
  status: text('status').$type<(typeof humanFeedbackStatuses)[number]>().notNull().default('received'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
  addressedAt: timestamp('addressed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('human_feedback_operation_key').on(table.projectId, table.operationKey),
  index('human_feedback_iteration_status').on(table.projectId, table.iterationId, table.status, table.createdAt),
  index('human_feedback_agent_status').on(table.agentId, table.status, table.createdAt),
  index('human_feedback_correlation').on(table.projectId, table.correlationId),
  check('human_feedback_status_check', sql`${table.status} IN ('received', 'acknowledged', 'addressed', 'dismissed')`),
  check('human_feedback_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  check('human_feedback_time_check', sql`
    (${table.acknowledgedAt} IS NULL OR ${table.acknowledgedAt} >= ${table.createdAt})
    AND (${table.addressedAt} IS NULL OR ${table.addressedAt} >= ${table.createdAt})
  `),
]);

export const modelInvocations = pgTable('model_invocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  actionId: uuid('action_id').references(() => agentActions.id, { onDelete: 'set null' }),
  provider: text('provider').$type<ModelProvider>().notNull(),
  model: text('model').notNull(),
  purpose: text('purpose').notNull(),
  status: text('status').$type<(typeof modelInvocationStatuses)[number]>().notNull().default('queued'),
  externalRequestId: text('external_request_id'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cachedTokens: integer('cached_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 18, scale: 8, mode: 'number' }).notNull().default(0),
  requestMetadata: jsonb('request_metadata').$type<Record<string, unknown>>().notNull().default({}),
  responseMetadata: jsonb('response_metadata').$type<Record<string, unknown>>().notNull().default({}),
  error: text('error'),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('model_invocation_operation_key').on(table.projectId, table.operationKey),
  index('model_invocation_agent_status').on(table.agentId, table.status, table.createdAt),
  index('model_invocation_iteration_created').on(table.projectId, table.iterationId, table.createdAt),
  index('model_invocation_external_request').on(table.provider, table.externalRequestId),
  index('model_invocation_correlation').on(table.projectId, table.correlationId),
  check('model_invocation_provider_check', sql`${table.provider} IN ('ollama', 'openrouter')`),
  check('model_invocation_status_check', sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
  check('model_invocation_token_check', sql`
    ${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0
    AND ${table.cachedTokens} >= 0 AND ${table.totalTokens} >= 0
  `),
  check('model_invocation_cost_check', sql`${table.costUsd} >= 0`),
  check('model_invocation_request_metadata_check', sql`jsonb_typeof(${table.requestMetadata}) = 'object'`),
  check('model_invocation_response_metadata_check', sql`jsonb_typeof(${table.responseMetadata}) = 'object'`),
  check('model_invocation_time_check', sql`${table.completedAt} IS NULL OR (${table.startedAt} IS NOT NULL AND ${table.completedAt} >= ${table.startedAt})`),
]);

export const repositoryOperations = pgTable('repository_operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').references(() => iterations.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  actionId: uuid('action_id').references(() => agentActions.id, { onDelete: 'set null' }),
  lifecycleRecordId: uuid('lifecycle_record_id').references(() => repositoryLifecycleRecords.id, { onDelete: 'set null' }),
  type: text('type').notNull(),
  status: text('status').$type<(typeof repositoryOperationStatuses)[number]>().notNull().default('queued'),
  mutating: boolean('mutating').notNull().default(false),
  repositoryUrl: text('repository_url'),
  branchName: text('branch_name'),
  paths: jsonb('paths').$type<string[]>().notNull().default([]),
  expectedBaseRevision: text('expected_base_revision'),
  resultingRevision: text('resulting_revision'),
  externalId: text('external_id'),
  summary: text('summary').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  correlationId: text('correlation_id'),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('repository_operation_operation_key').on(table.projectId, table.operationKey),
  uniqueIndex('repository_operation_running_mutation').on(table.projectId, table.branchName).where(sql`
    ${table.mutating} = true AND ${table.status} = 'running' AND ${table.branchName} IS NOT NULL
  `),
  index('repository_operation_iteration_status').on(table.projectId, table.iterationId, table.status, table.createdAt),
  index('repository_operation_agent_status').on(table.agentId, table.status, table.createdAt),
  index('repository_operation_branch_status').on(table.projectId, table.branchName, table.status),
  index('repository_operation_base_revision').on(table.projectId, table.expectedBaseRevision),
  index('repository_operation_result_revision').on(table.projectId, table.resultingRevision),
  check('repository_operation_status_check', sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'conflicted', 'cancelled')`),
  check('repository_operation_paths_array_check', sql`jsonb_typeof(${table.paths}) = 'array'`),
  check('repository_operation_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  check('repository_operation_time_check', sql`${table.completedAt} IS NULL OR (${table.startedAt} IS NOT NULL AND ${table.completedAt} >= ${table.startedAt})`),
]);

export const iterationReviewProposals = pgTable('iteration_review_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  iterationId: uuid('iteration_id').notNull().references(() => iterations.id, { onDelete: 'cascade' }),
  proposedByAgentId: uuid('proposed_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  proposalVersion: integer('proposal_version').notNull().default(1),
  status: text('status').$type<(typeof iterationReviewProposalStatuses)[number]>().notNull().default('draft'),
  objectiveStatus: text('objective_status').$type<'unsatisfied' | 'partially_satisfied' | 'satisfied' | 'satisfied_with_known_gaps'>().notNull(),
  includedRevision: text('included_revision').notNull(),
  completedOutcomes: jsonb('completed_outcomes').$type<string[]>().notNull().default([]),
  openFindings: jsonb('open_findings').$type<Array<Record<string, unknown>>>().notNull().default([]),
  agentPositions: jsonb('agent_positions').$type<Record<string, unknown>>().notNull().default({}),
  gateStatus: text('gate_status').$type<'pass' | 'block' | 'waiting'>().notNull(),
  gateRationale: text('gate_rationale'),
  managerRationale: text('manager_rationale'),
  recommendation: text('recommendation').$type<'continue_iteration' | 'send_for_human_review' | 'reduce_scope' | 'request_human_decision'>().notNull(),
  knownLimitations: jsonb('known_limitations').$type<string[]>().notNull().default([]),
  budgetSnapshot: jsonb('budget_snapshot').$type<Record<string, unknown>>().notNull().default({}),
  correlationId: text('correlation_id').notNull(),
  operationKey: text('operation_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('iteration_review_proposal_version').on(table.iterationId, table.includedRevision, table.proposalVersion),
  uniqueIndex('iteration_review_proposal_operation_key').on(table.projectId, table.operationKey),
  index('iteration_review_proposal_status').on(table.projectId, table.iterationId, table.status, table.createdAt),
  index('iteration_review_proposal_revision').on(table.projectId, table.includedRevision),
  index('iteration_review_proposal_correlation').on(table.projectId, table.correlationId),
  check('iteration_review_proposal_version_check', sql`${table.proposalVersion} > 0`),
  check('iteration_review_proposal_status_check', sql`${table.status} IN ('draft', 'proposed', 'gate_blocked', 'superseded', 'accepted', 'rejected')`),
  check('iteration_review_proposal_objective_check', sql`${table.objectiveStatus} IN ('unsatisfied', 'partially_satisfied', 'satisfied', 'satisfied_with_known_gaps')`),
  check('iteration_review_proposal_gate_check', sql`${table.gateStatus} IN ('pass', 'block', 'waiting')`),
  check('iteration_review_proposal_recommendation_check', sql`${table.recommendation} IN ('continue_iteration', 'send_for_human_review', 'reduce_scope', 'request_human_decision')`),
  check('iteration_review_proposal_outcomes_array_check', sql`jsonb_typeof(${table.completedOutcomes}) = 'array'`),
  check('iteration_review_proposal_findings_array_check', sql`jsonb_typeof(${table.openFindings}) = 'array'`),
  check('iteration_review_proposal_positions_object_check', sql`jsonb_typeof(${table.agentPositions}) = 'object'`),
  check('iteration_review_proposal_limitations_array_check', sql`jsonb_typeof(${table.knownLimitations}) = 'array'`),
  check('iteration_review_proposal_budget_object_check', sql`jsonb_typeof(${table.budgetSnapshot}) = 'object'`),
  check('iteration_review_proposal_time_check', sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.createdAt}`),
]);

export const projectsRelations = relations(projects, ({ many }) => ({
  iterations: many(iterations),
  events: many(projectEvents),
  artifacts: many(artifacts),
  media: many(projectMedia),
  questions: many(agentQuestions),
  comments: many(agentComments),
  iterationReviews: many(iterationReviews),
  artifactFeedback: many(artifactFeedback),
  repositoryLifecycleRecords: many(repositoryLifecycleRecords),
  agents: many(agents),
  agentRuntimeStates: many(agentRuntimeStates),
  agentGoals: many(agentGoals),
  agentActionPlans: many(agentActionPlans),
  agentActions: many(agentActions),
  messageThreads: many(messageThreads),
  agentMessages: many(agentMessages),
  agentObligations: many(agentObligations),
  artifactVersions: many(artifactVersions),
  findings: many(findings),
  humanDecisions: many(humanDecisions),
  humanFeedback: many(humanFeedback),
  modelInvocations: many(modelInvocations),
  repositoryOperations: many(repositoryOperations),
  iterationReviewProposals: many(iterationReviewProposals),
}));

export const iterationsRelations = relations(iterations, ({ one, many }) => ({
  project: one(projects, { fields: [iterations.projectId], references: [projects.id] }),
  artifacts: many(artifacts),
  media: many(projectMedia),
  questions: many(agentQuestions),
  comments: many(agentComments),
  reviews: many(iterationReviews),
  artifactFeedback: many(artifactFeedback),
  repositoryLifecycleRecords: many(repositoryLifecycleRecords),
  agentRuntimeStates: many(agentRuntimeStates),
  agentGoals: many(agentGoals),
  agentActionPlans: many(agentActionPlans),
  agentActions: many(agentActions),
  messageThreads: many(messageThreads),
  agentMessages: many(agentMessages),
  agentObligations: many(agentObligations),
  artifactVersions: many(artifactVersions),
  findings: many(findings),
  humanDecisions: many(humanDecisions),
  humanFeedback: many(humanFeedback),
  modelInvocations: many(modelInvocations),
  repositoryOperations: many(repositoryOperations),
  reviewProposals: many(iterationReviewProposals),
}));

export const agentQuestionsRelations = relations(agentQuestions, ({ one, many }) => ({
  project: one(projects, { fields: [agentQuestions.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [agentQuestions.iterationId], references: [iterations.id] }),
  options: many(agentQuestionOptions),
  answers: many(agentQuestionAnswers),
  humanDecisions: many(humanDecisions),
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
  humanDecisions: many(humanDecisions),
  humanFeedback: many(humanFeedback),
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

export const repositoryLifecycleRecordsRelations = relations(repositoryLifecycleRecords, ({ one, many }) => ({
  project: one(projects, { fields: [repositoryLifecycleRecords.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [repositoryLifecycleRecords.iterationId], references: [iterations.id] }),
  operations: many(repositoryOperations),
}));

export const projectEventsRelations = relations(projectEvents, ({ one }) => ({
  project: one(projects, { fields: [projectEvents.projectId], references: [projects.id] }),
}));

export const artifactsRelations = relations(artifacts, ({ one, many }) => ({
  project: one(projects, { fields: [artifacts.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [artifacts.iterationId], references: [iterations.id] }),
  versions: many(artifactVersions),
  feedback: many(artifactFeedback),
  humanFeedback: many(humanFeedback),
}));

export const projectMediaRelations = relations(projectMedia, ({ one }) => ({
  project: one(projects, { fields: [projectMedia.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [projectMedia.iterationId], references: [iterations.id] }),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  project: one(projects, { fields: [agents.projectId], references: [projects.id] }),
  runtimeStates: many(agentRuntimeStates),
  goals: many(agentGoals),
  actionPlans: many(agentActionPlans),
  actions: many(agentActions),
  sentMessages: many(agentMessages),
  obligations: many(agentObligations),
  producedArtifactVersions: many(artifactVersions),
  findingsRaised: many(findings, { relationName: 'findingRaisedBy' }),
  findingsOwned: many(findings, { relationName: 'findingOwnedBy' }),
  humanFeedback: many(humanFeedback),
  modelInvocations: many(modelInvocations),
  repositoryOperations: many(repositoryOperations),
  reviewProposals: many(iterationReviewProposals),
}));

export const agentRuntimeStatesRelations = relations(agentRuntimeStates, ({ one }) => ({
  project: one(projects, { fields: [agentRuntimeStates.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [agentRuntimeStates.iterationId], references: [iterations.id] }),
  agent: one(agents, { fields: [agentRuntimeStates.agentId], references: [agents.id] }),
}));

export const agentGoalsRelations = relations(agentGoals, ({ one, many }) => ({
  project: one(projects, { fields: [agentGoals.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [agentGoals.iterationId], references: [iterations.id] }),
  agent: one(agents, { fields: [agentGoals.agentId], references: [agents.id] }),
  plans: many(agentActionPlans),
  obligations: many(agentObligations),
}));

export const agentActionPlansRelations = relations(agentActionPlans, ({ one, many }) => ({
  project: one(projects, { fields: [agentActionPlans.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [agentActionPlans.iterationId], references: [iterations.id] }),
  agent: one(agents, { fields: [agentActionPlans.agentId], references: [agents.id] }),
  goal: one(agentGoals, { fields: [agentActionPlans.goalId], references: [agentGoals.id] }),
  actions: many(agentActions),
}));

export const agentActionsRelations = relations(agentActions, ({ one, many }) => ({
  project: one(projects, { fields: [agentActions.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [agentActions.iterationId], references: [iterations.id] }),
  agent: one(agents, { fields: [agentActions.agentId], references: [agents.id] }),
  plan: one(agentActionPlans, { fields: [agentActions.planId], references: [agentActionPlans.id] }),
  obligations: many(agentObligations),
  findings: many(findings),
  modelInvocations: many(modelInvocations),
  repositoryOperations: many(repositoryOperations),
}));

export const messageThreadsRelations = relations(messageThreads, ({ one, many }) => ({
  project: one(projects, { fields: [messageThreads.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [messageThreads.iterationId], references: [iterations.id] }),
  messages: many(agentMessages),
}));

export const agentMessagesRelations = relations(agentMessages, ({ one, many }) => ({
  project: one(projects, { fields: [agentMessages.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [agentMessages.iterationId], references: [iterations.id] }),
  thread: one(messageThreads, { fields: [agentMessages.threadId], references: [messageThreads.id] }),
  sender: one(agents, { fields: [agentMessages.senderAgentId], references: [agents.id] }),
  causedBy: one(agentMessages, {
    fields: [agentMessages.causationMessageId],
    references: [agentMessages.id],
    relationName: 'agentMessageCausation',
  }),
  causedMessages: many(agentMessages, { relationName: 'agentMessageCausation' }),
}));

export const agentObligationsRelations = relations(agentObligations, ({ one, many }) => ({
  project: one(projects, { fields: [agentObligations.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [agentObligations.iterationId], references: [iterations.id] }),
  owner: one(agents, { fields: [agentObligations.ownerAgentId], references: [agents.id] }),
  goal: one(agentGoals, { fields: [agentObligations.goalId], references: [agentGoals.id] }),
  action: one(agentActions, { fields: [agentObligations.actionId], references: [agentActions.id] }),
  findings: many(findings),
}));

export const artifactVersionsRelations = relations(artifactVersions, ({ one, many }) => ({
  project: one(projects, { fields: [artifactVersions.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [artifactVersions.iterationId], references: [iterations.id] }),
  artifact: one(artifacts, { fields: [artifactVersions.artifactId], references: [artifacts.id] }),
  producedByAgent: one(agents, { fields: [artifactVersions.producedByAgentId], references: [agents.id] }),
  supersedes: one(artifactVersions, {
    fields: [artifactVersions.supersedesVersionId],
    references: [artifactVersions.id],
    relationName: 'artifactVersionSupersession',
  }),
  supersededBy: many(artifactVersions, { relationName: 'artifactVersionSupersession' }),
  findings: many(findings),
  humanFeedback: many(humanFeedback),
}));

export const findingsRelations = relations(findings, ({ one }) => ({
  project: one(projects, { fields: [findings.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [findings.iterationId], references: [iterations.id] }),
  raisedBy: one(agents, {
    fields: [findings.raisedByAgentId],
    references: [agents.id],
    relationName: 'findingRaisedBy',
  }),
  owner: one(agents, {
    fields: [findings.ownerAgentId],
    references: [agents.id],
    relationName: 'findingOwnedBy',
  }),
  obligation: one(agentObligations, { fields: [findings.obligationId], references: [agentObligations.id] }),
  action: one(agentActions, { fields: [findings.actionId], references: [agentActions.id] }),
  artifactVersion: one(artifactVersions, { fields: [findings.artifactVersionId], references: [artifactVersions.id] }),
}));

export const humanDecisionsRelations = relations(humanDecisions, ({ one, many }) => ({
  project: one(projects, { fields: [humanDecisions.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [humanDecisions.iterationId], references: [iterations.id] }),
  question: one(agentQuestions, { fields: [humanDecisions.questionId], references: [agentQuestions.id] }),
  review: one(iterationReviews, { fields: [humanDecisions.reviewId], references: [iterationReviews.id] }),
  supersedes: one(humanDecisions, {
    fields: [humanDecisions.supersedesDecisionId],
    references: [humanDecisions.id],
    relationName: 'humanDecisionSupersession',
  }),
  supersededBy: many(humanDecisions, { relationName: 'humanDecisionSupersession' }),
  feedback: many(humanFeedback),
}));

export const humanFeedbackRelations = relations(humanFeedback, ({ one }) => ({
  project: one(projects, { fields: [humanFeedback.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [humanFeedback.iterationId], references: [iterations.id] }),
  decision: one(humanDecisions, { fields: [humanFeedback.decisionId], references: [humanDecisions.id] }),
  review: one(iterationReviews, { fields: [humanFeedback.reviewId], references: [iterationReviews.id] }),
  artifact: one(artifacts, { fields: [humanFeedback.artifactId], references: [artifacts.id] }),
  artifactVersion: one(artifactVersions, { fields: [humanFeedback.artifactVersionId], references: [artifactVersions.id] }),
  agent: one(agents, { fields: [humanFeedback.agentId], references: [agents.id] }),
}));

export const modelInvocationsRelations = relations(modelInvocations, ({ one }) => ({
  project: one(projects, { fields: [modelInvocations.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [modelInvocations.iterationId], references: [iterations.id] }),
  agent: one(agents, { fields: [modelInvocations.agentId], references: [agents.id] }),
  action: one(agentActions, { fields: [modelInvocations.actionId], references: [agentActions.id] }),
}));

export const repositoryOperationsRelations = relations(repositoryOperations, ({ one }) => ({
  project: one(projects, { fields: [repositoryOperations.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [repositoryOperations.iterationId], references: [iterations.id] }),
  agent: one(agents, { fields: [repositoryOperations.agentId], references: [agents.id] }),
  action: one(agentActions, { fields: [repositoryOperations.actionId], references: [agentActions.id] }),
  lifecycleRecord: one(repositoryLifecycleRecords, {
    fields: [repositoryOperations.lifecycleRecordId],
    references: [repositoryLifecycleRecords.id],
  }),
}));

export const iterationReviewProposalsRelations = relations(iterationReviewProposals, ({ one }) => ({
  project: one(projects, { fields: [iterationReviewProposals.projectId], references: [projects.id] }),
  iteration: one(iterations, { fields: [iterationReviewProposals.iterationId], references: [iterations.id] }),
  proposedBy: one(agents, { fields: [iterationReviewProposals.proposedByAgentId], references: [agents.id] }),
}));
