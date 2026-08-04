import { z } from 'zod';
import { agentInteractionSchema } from './agent-organism.js';
import { previewAttestationSchema, previewImageDigestSchema, previewRevisionSchema, type PreviewDeploymentResult } from './preview.js';

export * from './agent-organism.js';
export * from './model-provider.js';
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
  { role: 'manager', label: 'Manager', icon: '✦', phase: 'shape', artifactType: 'project-charter', artifactName: 'Project charter', projectStatus: 'defining', dependsOn: [], supervisedBy: [], consumes: ['project-intent'], produces: ['project-charter'] },
  { role: 'requirements', label: 'Requirements', icon: '≡', phase: 'shape', artifactType: 'requirements-baseline', artifactName: 'Requirements baseline', projectStatus: 'defining', dependsOn: ['manager'], supervisedBy: ['manager'], consumes: ['project-intent', 'project-charter'], produces: ['requirements-baseline'] },
  { role: 'product', label: 'Product', icon: '◎', phase: 'shape', artifactType: 'product-scope', artifactName: 'Product scope', projectStatus: 'defining', dependsOn: ['manager'], supervisedBy: ['manager'], consumes: ['project-intent', 'project-charter'], produces: ['product-scope'] },
  { role: 'ux', label: 'UX', icon: '◇', phase: 'design', artifactType: 'user-journeys', artifactName: 'User journeys', projectStatus: 'planning', dependsOn: ['requirements', 'product'], supervisedBy: ['product'], consumes: ['requirements-baseline', 'product-scope'], produces: ['user-journeys', 'user-flow-diagram'] },
  { role: 'architecture', label: 'Architecture', icon: '⌘', phase: 'design', artifactType: 'solution-baseline', artifactName: 'Solution baseline', projectStatus: 'planning', dependsOn: ['requirements', 'product'], supervisedBy: ['manager'], consumes: ['requirements-baseline', 'product-scope'], produces: ['solution-baseline'] },
  { role: 'data', label: 'Data', icon: '▦', phase: 'design', artifactType: 'data-model', artifactName: 'Data model', projectStatus: 'planning', dependsOn: ['architecture'], supervisedBy: ['architecture'], consumes: ['requirements-baseline', 'solution-baseline'], produces: ['data-model'] },
  { role: 'security', label: 'Security', icon: '⛉', phase: 'design', artifactType: 'threat-model', artifactName: 'Threat model', projectStatus: 'planning', dependsOn: ['architecture', 'ux'], supervisedBy: ['architecture'], consumes: ['requirements-baseline', 'user-journeys', 'solution-baseline'], produces: ['threat-model'] },
  { role: 'planner', label: 'Planner', icon: '↗', phase: 'plan', artifactType: 'iteration-plan', artifactName: 'Iteration plan', projectStatus: 'planning', dependsOn: ['ux', 'data', 'security'], supervisedBy: ['manager'], consumes: ['requirements-baseline', 'product-scope', 'user-journeys', 'solution-baseline', 'data-model', 'threat-model'], produces: ['iteration-plan'] },
  { role: 'builder', label: 'Builder', icon: '⌨', phase: 'build', artifactType: 'build-submission', artifactName: 'Build submission', projectStatus: 'building', dependsOn: ['planner'], supervisedBy: ['planner', 'architecture'], consumes: ['iteration-plan', 'user-journeys', 'solution-baseline', 'data-model', 'threat-model'], produces: ['build-submission', 'source-file:*'] },
  { role: 'test', label: 'Test', icon: '✓', phase: 'assure', artifactType: 'test-evidence', artifactName: 'Test evidence', projectStatus: 'reviewing', dependsOn: ['builder'], supervisedBy: ['planner'], consumes: ['requirements-baseline', 'threat-model', 'build-submission', 'source-file:*'], produces: ['test-evidence', 'user-flow-video'] },
  { role: 'reviewer', label: 'Reviewer', icon: '◉', phase: 'assure', artifactType: 'review-decision', artifactName: 'Review decision', projectStatus: 'reviewing', dependsOn: ['builder'], supervisedBy: ['manager'], consumes: ['requirements-baseline', 'solution-baseline', 'build-submission', 'source-file:*'], produces: ['review-decision'] },
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
    purpose: z.enum(['generate', 'quality_review', 'revise']),
    round: z.number().int().nonnegative(),
    requestId: z.string().optional(),
    usage: z.object({
      promptTokens: z.number().nonnegative().optional(),
      completionTokens: z.number().nonnegative().optional(),
      totalTokens: z.number().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    }).optional(),
  })).optional(),
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

export const agentExecutionStateSchema = z.enum(['dormant', 'waiting', 'ready', 'active', 'completed', 'blocked']);
export type AgentExecutionState = z.infer<typeof agentExecutionStateSchema>;

export const agentExecutionNodeSchema = z.object({
  role: agentRoleSchema,
  label: z.string(),
  icon: z.string(),
  phase: z.enum(['shape', 'design', 'plan', 'build', 'assure']),
  state: agentExecutionStateSchema,
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
});
export type AgentExecutionNode = z.infer<typeof agentExecutionNodeSchema>;

export const agentExecutionEdgeSchema = z.object({
  from: agentRoleSchema,
  to: agentRoleSchema,
  kind: z.enum(['blocks', 'supervises']),
  artifacts: z.array(z.string()),
});
export type AgentExecutionEdge = z.infer<typeof agentExecutionEdgeSchema>;

export const agentExecutionGraphSchema = z.object({
  iterationNumber: z.number().int().positive(),
  graphVersion: z.number().int().positive().default(1),
  nodes: z.array(agentExecutionNodeSchema),
  edges: z.array(agentExecutionEdgeSchema),
  modelConcurrency: z.number().int().positive(),
  interactions: z.array(agentInteractionSchema).optional(),
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

export const projectDetailSchema = z.object({
  project: projectSchema,
  iterations: z.array(iterationSchema),
  events: z.array(projectEventSchema),
  artifacts: z.array(artifactSchema),
  media: z.array(projectMediaSchema),
  executionGraph: agentExecutionGraphSchema.optional(),
  questions: z.array(agentQuestionSchema).optional(),
  agentComments: z.array(agentCommentSchema).optional(),
  artifactFeedback: z.array(artifactFeedbackSchema).optional(),
  iterationReviews: z.array(iterationReviewRecordSchema).optional(),
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
  content: string;
  mimeType: string;
  producedBy: AgentRole;
  repositoryUrl: string | null;
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
    purpose: 'generate' | 'quality_review' | 'revise';
    round: number;
    requestId?: string;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: number };
  }>;
  attachments?: ArtifactAttachmentDraft[];
  questions?: AgentQuestionDraft[];
  gateDecision?: GateDecision;
}

export interface AgentWorkflowInput extends AgentExecutionInput {
  artifactName: string;
  supervisedBy?: AgentRole[];
  handsOffTo?: AgentRole[];
  /** Exact runnable target supplied to Test by the project workflow. */
  preview?: PreviewDeploymentResult;
}

export interface AgentWorkflowResult {
  draft: AgentArtifactDraft;
  artifacts: ProjectArtifact[];
}
