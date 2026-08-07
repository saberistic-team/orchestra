import { z } from 'zod';
import { agentInteractionSchema, organismEventSchema } from './agent-organism.js';
import type { ForgejoIssueAction } from './forgejo-work.js';
import { previewAttestationSchema, previewImageDigestSchema, previewRevisionSchema, type PreviewDeploymentResult } from './preview.js';
import { dynamicExecutionTraceSchema, type DynamicExecutionLimits, type DynamicExecutionTrace } from './dynamic-execution.js';

export * from './agent-organism.js';
export * from './dynamic-execution.js';
export * from './forgejo-work.js';
export * from './model-provider.js';
export * from './packaging.js';
export * from './preview.js';
export * from './task-queues.js';

export const projectBriefSchema = z.object({
  name: z.string().trim().min(2).max(100),
  intent: z.string().trim().min(20).max(5_000),
  audience: z.string().trim().min(2).max(1_000),
  success: z.string().trim().min(10).max(2_000),
  constraints: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

export type ProjectBrief = z.infer<typeof projectBriefSchema>;

export const projectStatusSchema = z.enum([
  'discovering',
  'defining',
  'planning',
  'building',
  'reviewing',
  'awaiting_approval',
  'blocked',
  'completed',
]);

export const projectSchema = projectBriefSchema.extend({
  id: z.string().uuid(),
  status: projectStatusSchema,
  currentIteration: z.number().int().positive().default(1),
  previewUrl: z.string().url().nullable().default(null),
  repositoryUrl: z.string().url().nullable().default(null),
  repositoryOwner: z.string().nullable().default(null),
  repositoryName: z.string().nullable().default(null),
  forgejoProjectId: z.number().int().positive().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const agentRoleSchema = z.enum([
  'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
  'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation',
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export interface DeliveryAgentDefinition {
  role: AgentRole;
  label: string;
  icon: string;
  phase: 'shape' | 'design' | 'plan' | 'build' | 'assure';
  artifactType: string;
  artifactName: string;
  projectStatus: 'defining' | 'planning' | 'building' | 'reviewing';
  dependsOn: readonly AgentRole[];
  supervisedBy: readonly AgentRole[];
  consumes: readonly string[];
  produces: readonly string[];
  activation?: 'iteration' | 'authorized_release';
}

export const deliveryAgentGraph = [
  { role: 'manager', label: 'Manager', icon: '✦', phase: 'shape', artifactType: 'project-charter', artifactName: 'Project charter', projectStatus: 'defining', dependsOn: [], supervisedBy: [], consumes: ['project-intent'], produces: ['project-charter', 'work-packages'] },
  { role: 'requirements', label: 'Requirements', icon: '≡', phase: 'shape', artifactType: 'requirements-baseline', artifactName: 'Requirements baseline', projectStatus: 'defining', dependsOn: ['manager'], supervisedBy: ['manager'], consumes: ['project-intent', 'project-charter'], produces: ['requirements-baseline'] },
  { role: 'product', label: 'Product', icon: '◎', phase: 'shape', artifactType: 'product-scope', artifactName: 'Product scope', projectStatus: 'defining', dependsOn: ['manager'], supervisedBy: ['manager'], consumes: ['project-intent', 'project-charter'], produces: ['product-scope'] },
  { role: 'ux', label: 'UX', icon: '◇', phase: 'design', artifactType: 'user-journeys', artifactName: 'User journeys', projectStatus: 'planning', dependsOn: ['requirements', 'product'], supervisedBy: ['product'], consumes: ['requirements-baseline', 'product-scope'], produces: ['user-journeys', 'user-flow-diagram'] },
  { role: 'architecture', label: 'Architecture', icon: '⌘', phase: 'design', artifactType: 'solution-baseline', artifactName: 'Solution baseline', projectStatus: 'planning', dependsOn: ['requirements', 'product'], supervisedBy: ['manager'], consumes: ['requirements-baseline', 'product-scope'], produces: ['solution-baseline'] },
  { role: 'data', label: 'Data', icon: '▦', phase: 'design', artifactType: 'data-model', artifactName: 'Data model', projectStatus: 'planning', dependsOn: ['architecture'], supervisedBy: ['architecture'], consumes: ['requirements-baseline', 'solution-baseline'], produces: ['data-model'] },
  { role: 'security', label: 'Security', icon: '⛉', phase: 'design', artifactType: 'threat-model', artifactName: 'Threat model', projectStatus: 'planning', dependsOn: ['architecture', 'ux'], supervisedBy: ['architecture'], consumes: ['requirements-baseline', 'user-journeys', 'solution-baseline'], produces: ['threat-model'] },
  { role: 'planner', label: 'Planner', icon: '↗', phase: 'plan', artifactType: 'iteration-plan', artifactName: 'Iteration plan', projectStatus: 'planning', dependsOn: ['ux', 'data', 'security'], supervisedBy: ['manager'], consumes: ['requirements-baseline', 'product-scope', 'user-journeys', 'solution-baseline', 'data-model', 'threat-model'], produces: ['iteration-plan', 'packaging-plan'] },
  { role: 'builder', label: 'Builder', icon: '⌨', phase: 'build', artifactType: 'build-submission', artifactName: 'Build submission', projectStatus: 'building', dependsOn: ['planner'], supervisedBy: ['planner', 'architecture'], consumes: ['iteration-plan', 'packaging-plan', 'user-journeys', 'solution-baseline', 'data-model', 'threat-model'], produces: ['build-submission', 'source-file:*', 'packaging-evidence'] },
  { role: 'test', label: 'Test', icon: '✓', phase: 'assure', artifactType: 'test-evidence', artifactName: 'Test evidence', projectStatus: 'reviewing', dependsOn: ['builder'], supervisedBy: ['planner'], consumes: ['requirements-baseline', 'threat-model', 'build-submission', 'source-file:*', 'packaging-evidence'], produces: ['test-evidence', 'user-flow-video'] },
  { role: 'reviewer', label: 'Reviewer', icon: '◉', phase: 'assure', artifactType: 'review-decision', artifactName: 'Review decision', projectStatus: 'reviewing', dependsOn: ['builder'], supervisedBy: ['manager'], consumes: ['requirements-baseline', 'solution-baseline', 'build-submission', 'source-file:*', 'packaging-evidence'], produces: ['review-decision'] },
  { role: 'gate', label: 'Gate', icon: '◆', phase: 'assure', artifactType: 'gate-decision', artifactName: 'Gate decision', projectStatus: 'reviewing', dependsOn: ['test', 'reviewer', 'security'], supervisedBy: ['manager'], consumes: ['threat-model', 'test-evidence', 'review-decision'], produces: ['gate-decision'] },
  { role: 'deployment', label: 'Deployment', icon: '⇧', phase: 'assure', artifactType: 'release-plan', artifactName: 'Release plan', projectStatus: 'reviewing', dependsOn: ['gate'], supervisedBy: ['manager'], consumes: ['gate-decision', 'build-submission', 'data-model', 'threat-model', 'test-evidence'], produces: ['release-plan', 'deployment-evidence'], activation: 'authorized_release' },
  { role: 'validation', label: 'Validation', icon: '∴', phase: 'assure', artifactType: 'outcome-validation', artifactName: 'Outcome validation', projectStatus: 'reviewing', dependsOn: ['deployment'], supervisedBy: ['manager', 'product'], consumes: ['product-scope', 'requirements-baseline', 'user-journeys', 'deployment-evidence'], produces: ['outcome-validation'], activation: 'authorized_release' },
] as const satisfies readonly DeliveryAgentDefinition[];

export const iterationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  number: z.number().int().positive(),
  objective: z.string(),
  status: z.enum(['active', 'awaiting_review', 'changes_requested', 'approved', 'completed', 'blocked']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  issueNumber: z.number().int().positive().nullable(),
  branchName: z.string().nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  pullRequestUrl: z.string().url().nullable(),
});
export type ProjectIteration = z.infer<typeof iterationSchema>;

export const projectEventSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  iterationNumber: z.number().int().positive().nullable(),
  kind: z.enum(['project', 'agent', 'artifact', 'review', 'deployment', 'system']),
  title: z.string(),
  description: z.string(),
  agentRole: agentRoleSchema.nullable(),
  createdAt: z.string().datetime(),
});
export type ProjectEvent = z.infer<typeof projectEventSchema>;

export const artifactSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  iterationId: z.string().uuid(),
  type: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  content: z.string(),
  mimeType: z.string(),
  status: z.enum(['draft', 'ready_for_review', 'changes_requested', 'approved', 'superseded']),
  producedBy: agentRoleSchema,
  model: z.string().nullable(),
  modelProvider: z.enum(['ollama', 'openrouter']).nullable().optional(),
  modelInvocations: z.array(z.object({
    provider: z.enum(['ollama', 'openrouter']).optional(),
    model: z.string(),
    purpose: z.enum([
      'generate',
      'quality_review',
      'revise',
      'plan',
      'plan_repair',
      'progress_assessment',
      'completion_assessment',
    ]),
    round: z.number().int().nonnegative(),
    requestId: z.string().optional(),
    usage: z.object({
      promptTokens: z.number().nonnegative().optional(),
      completionTokens: z.number().nonnegative().optional(),
      reasoningTokens: z.number().nonnegative().optional(),
      totalTokens: z.number().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    }).optional(),
  })).optional(),
  executionTrace: dynamicExecutionTraceSchema.optional(),
  storageMode: z.enum(['repository', 'ledger']).optional(),
  repositoryPath: z.string().nullable(),
  repositoryUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
});
export type ProjectArtifact = z.infer<typeof artifactSchema>;

export const projectMediaSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  iterationId: z.string().uuid().nullable(),
  kind: z.enum(['user_flow_video', 'preview']),
  title: z.string(),
  url: z.string().url(),
  sourceRevision: previewRevisionSchema.nullable().default(null),
  imageDigest: previewImageDigestSchema.nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type ProjectMedia = z.infer<typeof projectMediaSchema>;

/**
 * Human-facing runtime states for persistent delivery actors.
 *
 * These describe organizational activity rather than Temporal worker status.
 * An agent may therefore be `observing` or `monitoring` without consuming a
 * model invocation.
 */
export const agentExecutionStateSchema = z.enum([
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
]);
export type AgentExecutionState = z.infer<typeof agentExecutionStateSchema>;

export const agentActivitySchema = z.object({
  type: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  startedAt: z.string().datetime().nullable().default(null),
});
export type AgentActivity = z.infer<typeof agentActivitySchema>;

export const agentRuntimeSnapshotSchema = z.object({
  role: agentRoleSchema,
  state: agentExecutionStateSchema,
  activity: agentActivitySchema.nullable().default(null),
  stateChangedAt: z.string().datetime().nullable().default(null),
  mailboxDepth: z.number().int().nonnegative().default(0),
  activeOrderCount: z.number().int().nonnegative().default(0),
  blockerCount: z.number().int().nonnegative().default(0),
  pendingQuestionCount: z.number().int().nonnegative().default(0),
  graphVersion: z.number().int().nonnegative().default(1),
  stateVersion: z.number().int().nonnegative().default(0),
});
export type AgentRuntimeSnapshot = z.infer<typeof agentRuntimeSnapshotSchema>;

export const agentExecutionNodeSchema = z.object({
  role: agentRoleSchema,
  label: z.string(),
  icon: z.string(),
  phase: z.enum(['shape', 'design', 'plan', 'build', 'assure']),
  state: agentExecutionStateSchema,
  activity: agentActivitySchema.nullable().optional(),
  stateChangedAt: z.string().datetime().nullable().optional(),
  assignedModel: z.string(),
  assignedProvider: z.enum(['ollama', 'openrouter']).optional(),
  artifactType: z.string(),
  artifactName: z.string(),
  dependsOn: z.array(agentRoleSchema),
  supervisedBy: z.array(agentRoleSchema),
  consumes: z.array(z.string()),
  produces: z.array(z.string()),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  tokenUse: z.number().int().nonnegative().optional(),
  openRouterCost: z.number().nonnegative().optional(),
  openMessageCount: z.number().int().nonnegative().optional(),
  blockingDependencyCount: z.number().int().nonnegative().optional(),
  humanAttention: z.boolean().optional(),
  latestArtifact: z.string().optional(),
  latestFinding: z.string().optional(),
});
export type AgentExecutionNode = z.infer<typeof agentExecutionNodeSchema>;

export const agentExecutionEdgeSchema = z.object({
  id: z.string().optional(),
  from: agentRoleSchema,
  to: agentRoleSchema,
  kind: z.enum(['blocks', 'supervises', 'communicates']),
  artifacts: z.array(z.string()),
  label: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  activeMessageIds: z.array(z.string()).optional(),
  correlationIds: z.array(z.string()).optional(),
  lastMessageAt: z.string().datetime().nullable().optional(),
});
export type AgentExecutionEdge = z.infer<typeof agentExecutionEdgeSchema>;

export const readinessStatusSchema = z.enum(['ready', 'waiting', 'blocked', 'not_required']);
export type ReadinessStatus = z.infer<typeof readinessStatusSchema>;

export const iterationReadinessItemSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  status: readinessStatusSchema,
  summary: z.string().trim().min(1),
  current: z.number().nonnegative().optional(),
  target: z.number().nonnegative().optional(),
});
export type IterationReadinessItem = z.infer<typeof iterationReadinessItemSchema>;

export const iterationReadinessSchema = z.object({
  objectiveStatus: z.enum(['unsatisfied', 'partially_satisfied', 'satisfied', 'satisfied_with_known_gaps']),
  includedRevision: z.string().nullable().default(null),
  items: z.array(iterationReadinessItemSchema),
  openCriticalFindings: z.number().int().nonnegative().default(0),
  openHighFindings: z.number().int().nonnegative().default(0),
  pendingHumanDecisions: z.number().int().nonnegative().default(0),
  gateStatus: z.enum(['not_started', 'evaluating', 'pass', 'blocked', 'waiting']).default('not_started'),
  managerRecommendation: z.enum(['continue_iteration', 'send_for_human_review', 'request_human_decision', 'reduce_scope']).default('continue_iteration'),
  managerRationale: z.string().trim().min(1),
  proposedAt: z.string().datetime().nullable().optional(),
});
export type IterationReadiness = z.infer<typeof iterationReadinessSchema>;

export const iterationReviewBudgetSnapshotSchema = z.object({
  modelInvocationCount: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  openRouterCostUsd: z.number().nonnegative().default(0),
  repositoryOperationCount: z.number().int().nonnegative().default(0),
  activeMutationCount: z.number().int().nonnegative().default(0),
});
export type IterationReviewBudgetSnapshot = z.infer<typeof iterationReviewBudgetSnapshotSchema>;

export const iterationReviewProposalSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  iterationId: z.string().trim().min(1),
  iterationNumber: z.number().int().positive(),
  type: z.literal('iteration_review_proposal'),
  proposalVersion: z.number().int().positive().default(1),
  status: z.enum(['draft', 'proposed', 'gate_blocked', 'superseded', 'accepted', 'rejected']).default('proposed'),
  objectiveStatus: z.enum(['unsatisfied', 'partially_satisfied', 'satisfied', 'satisfied_with_known_gaps']),
  includedRevision: z.string().trim().min(1),
  completedOutcomes: z.array(z.string().trim().min(1)),
  openFindings: z.array(z.object({
    findingId: z.string().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    summary: z.string().trim().min(1),
    disposition: z.enum(['resolve_in_iteration', 'accepted_risk', 'defer_to_next_iteration', 'human_decision_required']),
  })),
  agentPositions: z.record(agentRoleSchema, z.enum(['ready', 'ready_with_findings', 'ready_with_accepted_risk', 'not_ready', 'not_required'])),
  gateStatus: z.enum(['pass', 'blocked']),
  gateRationale: z.string().trim().min(1),
  managerRationale: z.string().trim().min(1),
  recommendation: z.enum(['send_for_human_review', 'continue_iteration', 'request_human_decision', 'reduce_scope']),
  knownLimitations: z.array(z.string().trim().min(1)).default([]),
  budgetSnapshot: iterationReviewBudgetSnapshotSchema.default({
    modelInvocationCount: 0,
    totalTokens: 0,
    openRouterCostUsd: 0,
    repositoryOperationCount: 0,
    activeMutationCount: 0,
  }),
  createdAt: z.string().datetime(),
});
export type IterationReviewProposal = z.infer<typeof iterationReviewProposalSchema>;

export const messageThreadSchema = z.object({
  id: z.string().trim().min(1),
  correlationId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  participantRoles: z.array(agentRoleSchema),
  messageIds: z.array(z.string()),
  artifactIds: z.array(z.string()).default([]),
  findingIds: z.array(z.string()).default([]),
  status: z.enum(['active', 'waiting', 'resolved', 'blocked']),
  updatedAt: z.string().datetime(),
});
export type MessageThread = z.infer<typeof messageThreadSchema>;

export const agentExecutionGraphSchema = z.object({
  iterationNumber: z.number().int().positive(),
  graphVersion: z.number().int().positive().default(1),
  nodes: z.array(agentExecutionNodeSchema),
  edges: z.array(agentExecutionEdgeSchema),
  modelConcurrency: z.number().int().positive(),
  interactions: z.array(agentInteractionSchema).optional(),
  threads: z.array(messageThreadSchema).optional(),
  readiness: iterationReadinessSchema.optional(),
});
export type AgentExecutionGraph = z.infer<typeof agentExecutionGraphSchema>;

export const projectSummarySchema = projectSchema.extend({
  latestEvent: projectEventSchema.nullable(),
  artifactCount: z.number().int().nonnegative(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const agentQuestionOptionInputSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1_000).optional(),
});
export type AgentQuestionOptionInput = z.infer<typeof agentQuestionOptionInputSchema>;

export const agentQuestionOptionSchema = agentQuestionOptionInputSchema.extend({
  id: z.string().uuid(),
  questionId: z.string().uuid(),
  position: z.number().int().nonnegative(),
});
export type AgentQuestionOption = z.infer<typeof agentQuestionOptionSchema>;

export const agentQuestionAnswerInputSchema = z.discriminatedUnion('resolution', [
  z.object({
    resolution: z.literal('selected_option'),
    optionId: z.string().uuid(),
  }),
  z.object({
    resolution: z.literal('custom'),
    answer: z.string().trim().min(1).max(10_000),
  }),
  z.object({
    resolution: z.literal('agent_decides'),
  }),
]);
export type AgentQuestionAnswerInput = z.infer<typeof agentQuestionAnswerInputSchema>;

export const agentQuestionAnswerSchema = agentQuestionAnswerInputSchema.and(z.object({
  id: z.string().uuid(),
  questionId: z.string().uuid(),
  answeredBy: z.enum(['human', 'agent']),
  createdAt: z.string().datetime(),
}));
export type AgentQuestionAnswer = z.infer<typeof agentQuestionAnswerSchema>;

export const agentQuestionDraftSchema = z.object({
  decisionKey: z.string().trim().toLowerCase()
    .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
    .max(200)
    .optional(),
  question: z.string().trim().min(1).max(5_000),
  context: z.string().trim().max(10_000).optional(),
  options: z.array(agentQuestionOptionInputSchema).min(1).max(12),
  allowCustomAnswer: z.boolean().default(true),
  allowAgentDecide: z.boolean().default(true),
});
export type AgentQuestionDraft = z.infer<typeof agentQuestionDraftSchema>;

export const agentQuestionInputSchema = agentQuestionDraftSchema.extend({
  projectId: z.string().uuid(),
  iterationId: z.string().uuid().nullable().optional(),
  agentRole: agentRoleSchema,
});
export type AgentQuestionInput = z.infer<typeof agentQuestionInputSchema>;

export const agentQuestionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  iterationId: z.string().uuid().nullable(),
  agentRole: agentRoleSchema,
  decisionKey: z.string(),
  reusedFromQuestionId: z.string().uuid().nullable(),
  question: z.string(),
  context: z.string().nullable(),
  status: z.enum(['pending', 'answered', 'dismissed']),
  allowCustomAnswer: z.boolean(),
  allowAgentDecide: z.boolean(),
  options: z.array(agentQuestionOptionSchema),
  answer: agentQuestionAnswerSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;

export const agentCommentInputSchema = z.object({
  projectId: z.string().uuid(),
  iterationId: z.string().uuid().nullable().optional(),
  agentRole: agentRoleSchema,
  body: z.string().trim().min(1).max(10_000),
  authorType: z.enum(['human', 'agent', 'system']).default('human'),
  authorRole: agentRoleSchema.optional(),
});
export type AgentCommentInput = z.infer<typeof agentCommentInputSchema>;

export const agentCommentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  iterationId: z.string().uuid().nullable(),
  agentRole: agentRoleSchema,
  body: z.string(),
  authorType: z.enum(['human', 'agent', 'system']),
  authorRole: agentRoleSchema.nullable(),
  createdAt: z.string().datetime(),
});
export type AgentComment = z.infer<typeof agentCommentSchema>;

/** Input item used both independently and inside a structured iteration review. */
export const artifactFeedbackInputSchema = z.object({
  artifactId: z.string().uuid(),
  feedback: z.string().trim().max(10_000),
});
export type ArtifactFeedbackInput = z.infer<typeof artifactFeedbackInputSchema>;

export const artifactFeedbackSchema = artifactFeedbackInputSchema.extend({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  iterationId: z.string().uuid(),
  reviewId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type ArtifactFeedback = z.infer<typeof artifactFeedbackSchema>;

export const iterationAgentFeedbackInputSchema = z.object({
  role: agentRoleSchema,
  // Empty feedback is an intentional value: it means the human reviewed this role
  // and had no role-specific direction to add.
  feedback: z.string().trim().max(5_000),
});
export type IterationAgentFeedbackInput = z.infer<typeof iterationAgentFeedbackInputSchema>;

const exhaustiveAgentFeedbackSchema = z.array(iterationAgentFeedbackInputSchema)
  .length(agentRoleSchema.options.length)
  .superRefine((entries, context) => {
    const roles = new Set(entries.map((entry) => entry.role));
    for (const role of agentRoleSchema.options) {
      if (!roles.has(role)) {
        context.addIssue({
          code: 'custom',
          message: `Missing feedback value for ${role}`,
        });
      }
    }
  });

export const iterationReviewDecisionSchema = z.enum([
  'approve',
  'request_changes',
  // Backward-compatible spellings used by existing workflow signals.
  'approved',
  'changes_requested',
]);
export type IterationReviewDecision = z.infer<typeof iterationReviewDecisionSchema>;

export const iterationReviewSchema = z.object({
  decision: iterationReviewDecisionSchema,
  feedback: z.string().trim().max(5_000).default(''),
  overallDirection: z.string().trim().max(10_000).optional(),
  agentFeedback: exhaustiveAgentFeedbackSchema.optional(),
  artifactFeedback: z.array(artifactFeedbackInputSchema).optional(),
  previewAttestation: previewAttestationSchema.nullable().optional(),
});
export type IterationReview = z.infer<typeof iterationReviewSchema>;

export const reviewCheckpointSchema = z.object({
  iterationId: z.string().uuid(),
  iterationNumber: z.number().int().positive(),
  pullRequestNumber: z.number().int().positive(),
  reviewToken: z.string().trim().min(1).max(500),
  // Optional during the Temporal rollout so legacy workflow histories remain
  // queryable. New revision-bound checkpoints always populate all four fields.
  previewRevision: previewRevisionSchema.optional(),
  previewImageDigest: previewImageDigestSchema.optional(),
  previewExpiresAt: z.string().datetime().optional(),
  previewUrl: z.string().url().optional(),
});
export type ReviewCheckpoint = z.infer<typeof reviewCheckpointSchema>;

export const iterationReviewSubmissionSchema = z.object({
  iterationId: z.string().uuid(),
  reviewToken: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().uuid(),
  review: iterationReviewSchema,
});
export type IterationReviewSubmission = z.infer<typeof iterationReviewSubmissionSchema>;

export const persistedIterationReviewDecisionSchema = z.enum(['approve', 'request_changes']);
export type PersistedIterationReviewDecision = z.infer<typeof persistedIterationReviewDecisionSchema>;

export const iterationAgentFeedbackSchema = iterationAgentFeedbackInputSchema.extend({
  id: z.string().uuid(),
  reviewId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type IterationAgentFeedback = z.infer<typeof iterationAgentFeedbackSchema>;

export const iterationReviewRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  iterationId: z.string().uuid(),
  iterationNumber: z.number().int().positive(),
  decision: persistedIterationReviewDecisionSchema,
  feedback: z.string(),
  overallDirection: z.string(),
  agentFeedback: z.array(iterationAgentFeedbackSchema).length(agentRoleSchema.options.length),
  artifactFeedback: z.array(artifactFeedbackSchema),
  previewAttestation: previewAttestationSchema.nullable(),
  createdAt: z.string().datetime(),
});
export type IterationReviewRecord = z.infer<typeof iterationReviewRecordSchema>;

export const repositoryLifecycleKindSchema = z.enum([
  'repository_connected',
  'issue_created',
  'branch_created',
  'pull_request_opened',
  'pull_request_updated',
  'review_recorded',
  'pull_request_merged',
  'deployment_started',
  'deployment_completed',
  'repository_archived',
  'operation_failed',
]);
export type RepositoryLifecycleKind = z.infer<typeof repositoryLifecycleKindSchema>;

export const repositoryLifecycleInputSchema = z.object({
  projectId: z.string().uuid(),
  iterationId: z.string().uuid().nullable().optional(),
  kind: repositoryLifecycleKindSchema,
  status: z.enum(['pending', 'completed', 'failed']),
  repositoryUrl: z.string().url().nullable().optional(),
  externalId: z.string().trim().min(1).max(500).nullable().optional(),
  summary: z.string().trim().min(1).max(5_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RepositoryLifecycleInput = z.infer<typeof repositoryLifecycleInputSchema>;

export const repositoryLifecycleRecordSchema = repositoryLifecycleInputSchema.extend({
  id: z.string().uuid(),
  iterationId: z.string().uuid().nullable(),
  repositoryUrl: z.string().url().nullable(),
  externalId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type RepositoryLifecycleRecord = z.infer<typeof repositoryLifecycleRecordSchema>;

const canonicalLedgerIdentitySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  iterationId: z.string().uuid().nullable(),
});

export const agentGoalRecordSchema = canonicalLedgerIdentitySchema.extend({
  role: agentRoleSchema,
  objective: z.string(),
  status: z.enum(['active', 'satisfied', 'blocked', 'abandoned', 'superseded']),
  priority: z.enum(['low', 'normal', 'high', 'critical']),
  successCriteria: z.array(z.string()),
  correlationId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type AgentGoalRecord = z.infer<typeof agentGoalRecordSchema>;

export const agentActionPlanRecordSchema = canonicalLedgerIdentitySchema.extend({
  role: agentRoleSchema,
  goalId: z.string().uuid().nullable(),
  version: z.number().int().positive(),
  summary: z.string(),
  rationale: z.string().nullable(),
  status: z.enum(['draft', 'active', 'completed', 'blocked', 'superseded', 'cancelled']),
  sourceRevision: z.string().nullable(),
  correlationId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type AgentActionPlanRecord = z.infer<typeof agentActionPlanRecordSchema>;

export const agentActionRecordSchema = canonicalLedgerIdentitySchema.extend({
  role: agentRoleSchema,
  planId: z.string().uuid().nullable(),
  position: z.number().int().nonnegative(),
  kind: z.string(),
  summary: z.string(),
  status: z.enum(['pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'superseded']),
  blocking: z.boolean(),
  dependencyActionIds: z.array(z.string()),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  correlationId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type AgentActionRecord = z.infer<typeof agentActionRecordSchema>;

export const agentObligationRecordSchema = canonicalLedgerIdentitySchema.extend({
  ownerRole: agentRoleSchema,
  goalId: z.string().uuid().nullable(),
  actionId: z.string().uuid().nullable(),
  type: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'ready', 'in_progress', 'blocked', 'satisfied', 'waived', 'deferred', 'failed']),
  priority: z.enum(['low', 'normal', 'high', 'critical']),
  mandatory: z.boolean(),
  blocking: z.boolean(),
  subjectReferences: z.array(z.string()),
  dependencyReferences: z.array(z.string()),
  satisfactionEvidence: z.array(z.string()),
  disposition: z.string().nullable(),
  sourceRevision: z.string().nullable(),
  correlationId: z.string().nullable(),
  dueAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  satisfiedAt: z.string().datetime().nullable(),
});
export type AgentObligationRecord = z.infer<typeof agentObligationRecordSchema>;

export const artifactVersionRecordSchema = canonicalLedgerIdentitySchema.extend({
  artifactId: z.string().uuid(),
  artifactType: z.string(),
  artifactName: z.string(),
  producedByRole: agentRoleSchema.nullable(),
  version: z.number().int().positive(),
  status: z.enum(['draft', 'ready_for_review', 'changes_requested', 'approved', 'superseded']),
  content: z.string(),
  mimeType: z.string(),
  contentHash: z.string().nullable(),
  storageUri: z.string().nullable(),
  repositoryPath: z.string().nullable(),
  sourceRevision: z.string().nullable(),
  supersedesVersionId: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type ArtifactVersionRecord = z.infer<typeof artifactVersionRecordSchema>;

export const findingRecordSchema = canonicalLedgerIdentitySchema.extend({
  raisedByRole: agentRoleSchema.nullable(),
  ownerRole: agentRoleSchema.nullable(),
  obligationId: z.string().uuid().nullable(),
  actionId: z.string().uuid().nullable(),
  artifactVersionId: z.string().uuid().nullable(),
  category: z.string(),
  title: z.string(),
  description: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  status: z.enum(['open', 'acknowledged', 'remediating', 'resolved', 'accepted_risk', 'dismissed']),
  disposition: z.enum(['block_iteration', 'remediate_current', 'defer_to_next_iteration', 'accepted_risk', 'not_applicable']).nullable(),
  subjectReferences: z.array(z.string()),
  evidenceReferences: z.array(z.string()),
  sourceRevision: z.string().nullable(),
  correlationId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});
export type FindingRecord = z.infer<typeof findingRecordSchema>;

export const modelInvocationRecordSchema = canonicalLedgerIdentitySchema.extend({
  role: agentRoleSchema.nullable(),
  actionId: z.string().uuid().nullable(),
  provider: z.enum(['ollama', 'openrouter']),
  model: z.string(),
  purpose: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  externalRequestId: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  requestMetadata: z.record(z.string(), z.unknown()),
  responseMetadata: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  correlationId: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ModelInvocationRecord = z.infer<typeof modelInvocationRecordSchema>;

export const repositoryOperationRecordSchema = canonicalLedgerIdentitySchema.extend({
  role: agentRoleSchema.nullable(),
  actionId: z.string().uuid().nullable(),
  lifecycleRecordId: z.string().uuid().nullable(),
  type: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'conflicted', 'cancelled']),
  mutating: z.boolean(),
  repositoryUrl: z.string().nullable(),
  branchName: z.string().nullable(),
  paths: z.array(z.string()),
  expectedBaseRevision: z.string().nullable(),
  resultingRevision: z.string().nullable(),
  externalId: z.string().nullable(),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  correlationId: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type RepositoryOperationRecord = z.infer<typeof repositoryOperationRecordSchema>;

export const projectDetailSchema = z.object({
  project: projectSchema,
  iterations: z.array(iterationSchema),
  events: z.array(projectEventSchema),
  artifacts: z.array(artifactSchema),
  media: z.array(projectMediaSchema),
  executionGraph: agentExecutionGraphSchema.optional(),
  /**
   * Canonical, typed activity projected from the durable organism ledger.
   * Snapshots may omit it while older workers are still being drained.
   */
  organismEvents: z.array(organismEventSchema).optional(),
  agentRuntimeSnapshots: z.array(agentRuntimeSnapshotSchema).optional(),
  agentMessages: z.array(agentInteractionSchema).optional(),
  iterationReviewProposals: z.array(iterationReviewProposalSchema).optional(),
  questions: z.array(agentQuestionSchema).optional(),
  agentComments: z.array(agentCommentSchema).optional(),
  artifactFeedback: z.array(artifactFeedbackSchema).optional(),
  iterationReviews: z.array(iterationReviewRecordSchema).optional(),
  agentGoals: z.array(agentGoalRecordSchema).optional(),
  agentActionPlans: z.array(agentActionPlanRecordSchema).optional(),
  agentActions: z.array(agentActionRecordSchema).optional(),
  agentObligations: z.array(agentObligationRecordSchema).optional(),
  artifactVersions: z.array(artifactVersionRecordSchema).optional(),
  findings: z.array(findingRecordSchema).optional(),
  modelInvocations: z.array(modelInvocationRecordSchema).optional(),
  repositoryOperations: z.array(repositoryOperationRecordSchema).optional(),
  reviewCheckpoint: reviewCheckpointSchema.nullable().optional(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

export interface AgentExecutionInput {
  project: Project;
  iteration: ProjectIteration;
  role: AgentRole;
  artifactType: string;
  context: string;
  inputArtifacts?: AgentArtifactReference[];
}

export interface AgentArtifactReference {
  id: string;
  type: string;
  name: string;
  version: number;
  mimeType: string;
  producedBy: AgentRole;
  /** Durable address resolved only inside an Activity, never inside Workflow history. */
  contentAddress: string;
  contentHash: string;
  byteLength: number;
  repositoryPath: string | null;
  repositoryUrl: string | null;
  /** Replay compatibility for histories created before addressed artifacts. */
  content?: string;
}

export function artifactContentAddress(projectId: string, artifactId: string, version: number) {
  return `orchestra-artifact://postgres/${projectId}/${artifactId}?version=${version}`;
}

export interface ArtifactAttachmentDraft {
  type: string;
  name: string;
  content: string;
  mimeType: 'text/markdown' | 'application/yaml' | 'application/json' | 'text/plain' | 'image/svg+xml';
}

export const gateDecisionSchema = z.object({
  status: z.enum(['pass', 'blocked']),
  rationale: z.string().trim().min(1).max(10_000),
  missingEvidence: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
});
export type GateDecision = z.infer<typeof gateDecisionSchema>;

export interface AgentArtifactDraft {
  type: string;
  name: string;
  content: string;
  mimeType: 'text/markdown' | 'application/yaml' | 'application/json' | 'text/plain' | 'image/svg+xml';
  producedBy: AgentRole;
  model: string;
  modelProvider?: 'ollama' | 'openrouter';
  modelInvocations?: Array<{
    provider?: 'ollama' | 'openrouter';
    model: string;
    purpose:
      | 'generate'
      | 'quality_review'
      | 'revise'
      | 'plan'
      | 'plan_repair'
      | 'progress_assessment'
      | 'completion_assessment';
    round: number;
    requestId?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
      cost?: number;
    };
  }>;
  attachments?: ArtifactAttachmentDraft[];
  questions?: AgentQuestionDraft[];
  gateDecision?: GateDecision;
  executionTrace?: DynamicExecutionTrace;
  forgejoIssueActions?: ForgejoIssueAction[];
}

export interface AgentWorkflowInput extends AgentExecutionInput {
  artifactName: string;
  supervisedBy?: AgentRole[];
  handsOffTo?: AgentRole[];
  /** Stable identity for side effects across retries of one logical role order. */
  executionOperationId?: string;
  /** Stable identity for one recoverable artifact candidate within the order. */
  artifactOperationId?: string;
  executionLimits?: Partial<DynamicExecutionLimits>;
  /** Durable human-decision identities that every plan must acknowledge. */
  requiredDecisionIds?: string[];
  /** Monotonic project-context version used to reject stale model plans. */
  executionContextVersion?: number;
  /** Exact runnable target supplied to Test by the project workflow. */
  preview?: PreviewDeploymentResult;
  /** Parent-owned rollout mode; child workflows must not infer this from their own history. */
  revisionBoundAssurance?: boolean;
  /** Parent commits completion only after the durable handoff succeeds. */
  deferCompletionLedger?: boolean;
}

export interface AgentWorkflowResult {
  draft: AgentArtifactDraft;
  artifacts: AgentArtifactReference[];
}
