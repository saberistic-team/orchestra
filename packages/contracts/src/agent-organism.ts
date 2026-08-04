import { z } from 'zod';

import type { AgentRole } from './index.js';

/**
 * Shared, durable protocol for the living delivery-agent organism.
 *
 * This module deliberately owns no orchestration behavior. It describes the
 * messages, authority, work, evidence, topology and UI projections that allow
 * the workflows and the application to speak the same language.
 */

export const organismAgentRoles = [
  'manager',
  'requirements',
  'product',
  'ux',
  'architecture',
  'data',
  'security',
  'planner',
  'builder',
  'test',
  'reviewer',
  'gate',
  'deployment',
  'validation',
] as const satisfies readonly AgentRole[];

const organismAgentRoleSchema = z.enum(organismAgentRoles);
const nonEmptyStringSchema = z.string().trim().min(1);
const timestampSchema = z.string().datetime();

export const responsibilities = {
  manager:
    'Define the delivery objective, scope, priorities, decision authority, and success boundaries.',
  requirements:
    'Produce explicit, traceable functional and nonfunctional requirements, assumptions, edge cases, and acceptance criteria without inventing business decisions.',
  product:
    'Prioritize customer value and define the smallest useful increment and measurable success signals.',
  ux:
    'Define user journeys, information architecture, accessibility expectations, and empty, error, loading, and recovery states.',
  architecture:
    'Define system boundaries, interfaces, major technical decisions, alternatives, risks, and consequences.',
  data:
    'Define entities, schemas, consistency, migration, lineage, retention, and sensitive-data handling.',
  security:
    'Threat-model the increment and identify permission, secret, dependency, prompt-injection, tool-abuse, and data-exfiltration controls.',
  planner:
    'Create bounded, dependency-ordered work packages with acceptance criteria, expected artifacts, tests, risks, and permissions.',
  builder:
    'Describe a complete reproducible implementation submission, changed behavior, tests, evidence, limitations, and blockers. Never claim unprovided execution evidence.',
  test:
    'Create an independent validation plan covering unit, integration, contract, end-to-end, accessibility, security, and regression risks.',
  reviewer:
    'Independently assess correctness, maintainability, architecture alignment, security, tests, evidence, and requirement traceability. Return a clear decision and severity-ranked findings.',
  gate:
    'Apply deterministic completion rules to the available evidence. Missing proof must block the gate rather than being assumed.',
  deployment:
    'Define a permission-bounded rollout, migration, smoke-test, observability, and rollback plan.',
  validation:
    'Evaluate whether the delivered result solves the intended user and business problem in realistic scenarios.',
} as const satisfies Record<AgentRole, string>;

export interface AgentAddress {
  projectId: string;
  role: AgentRole;
  workflowId: string;
  instanceId?: string;
}

export const agentAddressSchema = z.object({
  projectId: nonEmptyStringSchema,
  role: organismAgentRoleSchema,
  workflowId: nonEmptyStringSchema,
  instanceId: nonEmptyStringSchema.optional(),
});

export interface ActivityAddress {
  activityType: string;
  activityId: string;
  workflowId?: string;
  executionId?: string;
}

export const activityAddressSchema = z.object({
  activityType: nonEmptyStringSchema,
  activityId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema.optional(),
  executionId: nonEmptyStringSchema.optional(),
});

export interface HumanAddress {
  humanId: string;
  displayName?: string;
}

export const humanAddressSchema = z.object({
  humanId: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema.optional(),
});

export const authorityLevelSchema = z.enum([
  'PROJECT',
  'ITERATION',
  'DOMAIN',
  'WORK_PACKAGE',
  'REMEDIATION',
  'ADVISORY',
]);
export type AuthorityLevel = z.infer<typeof authorityLevelSchema>;

export interface AuthorityGrant {
  grantId: string;
  issuerRole: AgentRole | 'human' | 'system';
  level: AuthorityLevel;
  permittedActions: string[];
  permittedTargets: AgentRole[];
  scopeRefs: string[];
  delegatedBy?: string;
  validFrom?: string;
  expiresAt?: string;
  mayDelegate: boolean;
}

export const authorityGrantSchema = z.object({
  grantId: nonEmptyStringSchema,
  issuerRole: z.union([organismAgentRoleSchema, z.enum(['human', 'system'])]),
  level: authorityLevelSchema,
  permittedActions: z.array(nonEmptyStringSchema),
  permittedTargets: z.array(organismAgentRoleSchema),
  scopeRefs: z.array(nonEmptyStringSchema),
  delegatedBy: nonEmptyStringSchema.optional(),
  validFrom: timestampSchema.optional(),
  expiresAt: timestampSchema.optional(),
  mayDelegate: z.boolean(),
});

export const evidenceTypeSchema = z.enum([
  'SOURCE',
  'BUILD',
  'TEST',
  'REVIEW',
  'SECURITY_SCAN',
  'MIGRATION',
  'DEPLOYMENT',
  'METRIC',
  'SCREENSHOT',
  'LOG',
  'HUMAN_APPROVAL',
  'CUSTOMER_FEEDBACK',
]);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

export interface ArtifactReference {
  artifactId: string;
  artifactType: string;
  version: string;
  name?: string;
  ownerRole?: AgentRole;
  status?: 'DRAFT' | 'PROPOSED' | 'ACCEPTED' | 'SUPERSEDED' | 'REJECTED';
  storageUri?: string;
  contentHash?: string;
}

export const artifactReferenceSchema = z.object({
  artifactId: nonEmptyStringSchema,
  artifactType: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  name: nonEmptyStringSchema.optional(),
  ownerRole: organismAgentRoleSchema.optional(),
  status: z.enum(['DRAFT', 'PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'REJECTED']).optional(),
  storageUri: nonEmptyStringSchema.optional(),
  contentHash: nonEmptyStringSchema.optional(),
});

export interface DecisionReference {
  decisionId: string;
  summary?: string;
  version?: string;
}

export const decisionReferenceSchema = z.object({
  decisionId: nonEmptyStringSchema,
  summary: nonEmptyStringSchema.optional(),
  version: nonEmptyStringSchema.optional(),
});

export interface EvidenceProvenance {
  source: string;
  method: string;
  inputRefs: string[];
  reproducible: boolean;
  details?: Readonly<Record<string, unknown>>;
}

export const evidenceProvenanceSchema = z.object({
  source: nonEmptyStringSchema,
  method: nonEmptyStringSchema,
  inputRefs: z.array(nonEmptyStringSchema),
  reproducible: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export interface EvidenceReference {
  evidenceId: string;
  evidenceType: EvidenceType;
  producedBy: AgentAddress | ActivityAddress;
  producedAt: string;
  subjectRefs: string[];
  artifactRefs: ArtifactReference[];
  storageUri: string;
  contentHash: string;
  executionId?: string;
  environment?: string;
  freshness?: {
    validFrom: string;
    validUntil?: string;
  };
  provenance: EvidenceProvenance;
}

export const evidenceReferenceSchema = z.object({
  evidenceId: nonEmptyStringSchema,
  evidenceType: evidenceTypeSchema,
  producedBy: z.union([agentAddressSchema, activityAddressSchema]),
  producedAt: timestampSchema,
  subjectRefs: z.array(nonEmptyStringSchema),
  artifactRefs: z.array(artifactReferenceSchema),
  storageUri: nonEmptyStringSchema,
  contentHash: nonEmptyStringSchema,
  executionId: nonEmptyStringSchema.optional(),
  environment: nonEmptyStringSchema.optional(),
  freshness: z.object({
    validFrom: timestampSchema,
    validUntil: timestampSchema.optional(),
  }).optional(),
  provenance: evidenceProvenanceSchema,
});

export const findingSeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export interface Finding {
  findingId: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  category: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'REMEDIATING' | 'RESOLVED' | 'ACCEPTED_RISK';
  raisedBy: AgentAddress;
  ownerRole?: AgentRole;
  subjectRefs: string[];
  evidenceRefs: EvidenceReference[];
  createdAt: string;
  resolvedAt?: string;
}

export const findingSchema = z.object({
  findingId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  severity: findingSeveritySchema,
  category: nonEmptyStringSchema,
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'REMEDIATING', 'RESOLVED', 'ACCEPTED_RISK']),
  raisedBy: agentAddressSchema,
  ownerRole: organismAgentRoleSchema.optional(),
  subjectRefs: z.array(nonEmptyStringSchema),
  evidenceRefs: z.array(evidenceReferenceSchema),
  createdAt: timestampSchema,
  resolvedAt: timestampSchema.optional(),
});

export interface DecisionRecord {
  decisionId: string;
  projectId: string;
  question: string;
  optionsConsidered: string[];
  selectedOption: string;
  rationale: string;
  evidenceRefs: EvidenceReference[];
  decidedBy: AgentAddress | HumanAddress;
  authority: AuthorityGrant;
  appliesTo: string[];
  createdAt: string;
  supersedesDecisionId?: string;
  invalidatedByDecisionId?: string;
}

export const decisionRecordSchema = z.object({
  decisionId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  question: nonEmptyStringSchema,
  optionsConsidered: z.array(nonEmptyStringSchema),
  selectedOption: nonEmptyStringSchema,
  rationale: nonEmptyStringSchema,
  evidenceRefs: z.array(evidenceReferenceSchema),
  decidedBy: z.union([agentAddressSchema, humanAddressSchema]),
  authority: authorityGrantSchema,
  appliesTo: z.array(nonEmptyStringSchema),
  createdAt: timestampSchema,
  supersedesDecisionId: nonEmptyStringSchema.optional(),
  invalidatedByDecisionId: nonEmptyStringSchema.optional(),
});

export interface AssumptionRecord {
  assumptionId: string;
  statement: string;
  createdBy: AgentAddress;
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'INVALIDATED';
  appliesTo: string[];
  rationale?: string;
  createdAt: string;
  invalidatedAt?: string;
}

export const assumptionRecordSchema = z.object({
  assumptionId: nonEmptyStringSchema,
  statement: nonEmptyStringSchema,
  createdBy: agentAddressSchema,
  status: z.enum(['PROPOSED', 'ACCEPTED', 'REJECTED', 'INVALIDATED']),
  appliesTo: z.array(nonEmptyStringSchema),
  rationale: nonEmptyStringSchema.optional(),
  createdAt: timestampSchema,
  invalidatedAt: timestampSchema.optional(),
});

export interface QuestionRecord {
  questionId: string;
  question: string;
  askedBy: AgentAddress;
  targetRoles: AgentRole[];
  status: 'OPEN' | 'ANSWERED' | 'DEFERRED' | 'CANCELLED';
  contextRefs: string[];
  answer?: string;
  answeredBy?: AgentAddress | HumanAddress;
  createdAt: string;
  answeredAt?: string;
}

export const questionRecordSchema = z.object({
  questionId: nonEmptyStringSchema,
  question: nonEmptyStringSchema,
  askedBy: agentAddressSchema,
  targetRoles: z.array(organismAgentRoleSchema),
  status: z.enum(['OPEN', 'ANSWERED', 'DEFERRED', 'CANCELLED']),
  contextRefs: z.array(nonEmptyStringSchema),
  answer: nonEmptyStringSchema.optional(),
  answeredBy: z.union([agentAddressSchema, humanAddressSchema]).optional(),
  createdAt: timestampSchema,
  answeredAt: timestampSchema.optional(),
});

export interface LimitationRecord {
  limitationId: string;
  description: string;
  impact: string;
  affectedRefs: string[];
  mitigation?: string;
}

export const limitationRecordSchema = z.object({
  limitationId: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  impact: nonEmptyStringSchema,
  affectedRefs: z.array(nonEmptyStringSchema),
  mitigation: nonEmptyStringSchema.optional(),
});

export const agentOrderTypeSchema = z.enum([
  'DEFINE_INCREMENT',
  'ELABORATE_REQUIREMENTS',
  'DESIGN_UX',
  'DESIGN_ARCHITECTURE',
  'DESIGN_DATA',
  'THREAT_MODEL',
  'PLAN_WORK',
  'IMPLEMENT',
  'DESIGN_TESTS',
  'EXECUTE_TESTS',
  'REVIEW',
  'REMEDIATE',
  'EVALUATE_GATE',
  'DEPLOY',
  'ROLLBACK',
  'VALIDATE_OUTCOME',
  'INVESTIGATE',
  'REPLAN',
  'PAUSE',
  'RESUME',
  'CANCEL',
]);
export type AgentOrderType = z.infer<typeof agentOrderTypeSchema>;

export const agentPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']);
export type AgentPriority = z.infer<typeof agentPrioritySchema>;

export interface RecommendedAction {
  actionId: string;
  action: string;
  rationale: string;
  targetRole?: AgentRole;
  orderType?: AgentOrderType;
  priority: AgentPriority;
}

export const recommendedActionSchema = z.object({
  actionId: nonEmptyStringSchema,
  action: nonEmptyStringSchema,
  rationale: nonEmptyStringSchema,
  targetRole: organismAgentRoleSchema.optional(),
  orderType: agentOrderTypeSchema.optional(),
  priority: agentPrioritySchema,
});

export interface ScopeBoundary {
  included: string[];
  excluded: string[];
  affectedComponents: string[];
  workPackageRefs: string[];
  repositoryPaths?: string[];
  environments?: string[];
}

export const scopeBoundarySchema = z.object({
  included: z.array(nonEmptyStringSchema),
  excluded: z.array(nonEmptyStringSchema),
  affectedComponents: z.array(nonEmptyStringSchema),
  workPackageRefs: z.array(nonEmptyStringSchema),
  repositoryPaths: z.array(nonEmptyStringSchema).optional(),
  environments: z.array(nonEmptyStringSchema).optional(),
});

export interface OutputRequirement {
  artifactType: string;
  description: string;
  required: boolean;
  ownerRole?: AgentRole;
  format?: string;
}

export const outputRequirementSchema = z.object({
  artifactType: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  required: z.boolean(),
  ownerRole: organismAgentRoleSchema.optional(),
  format: nonEmptyStringSchema.optional(),
});

export interface AcceptanceCriterion {
  criterionId: string;
  description: string;
  mandatory: boolean;
  requirementRefs: string[];
  verificationMethod?: string;
}

export const acceptanceCriterionSchema = z.object({
  criterionId: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  mandatory: z.boolean(),
  requirementRefs: z.array(nonEmptyStringSchema),
  verificationMethod: nonEmptyStringSchema.optional(),
});

export interface EvidenceRequirement {
  evidenceType: EvidenceType;
  description: string;
  required: boolean;
  subjectRefs: string[];
  minimumCount?: number;
  maximumAgeSeconds?: number;
}

export const evidenceRequirementSchema = z.object({
  evidenceType: evidenceTypeSchema,
  description: nonEmptyStringSchema,
  required: z.boolean(),
  subjectRefs: z.array(nonEmptyStringSchema),
  minimumCount: z.number().int().nonnegative().optional(),
  maximumAgeSeconds: z.number().int().positive().optional(),
});

export interface DependencyReference {
  dependencyId: string;
  kind: 'ORDER' | 'ARTIFACT' | 'DECISION' | 'EVIDENCE' | 'EXTERNAL';
  refId: string;
  status: 'PENDING' | 'READY' | 'BLOCKED' | 'SATISFIED' | 'FAILED';
  required: boolean;
  description?: string;
}

export const dependencyReferenceSchema = z.object({
  dependencyId: nonEmptyStringSchema,
  kind: z.enum(['ORDER', 'ARTIFACT', 'DECISION', 'EVIDENCE', 'EXTERNAL']),
  refId: nonEmptyStringSchema,
  status: z.enum(['PENDING', 'READY', 'BLOCKED', 'SATISFIED', 'FAILED']),
  required: z.boolean(),
  description: nonEmptyStringSchema.optional(),
});

export interface OrderConstraints {
  allowedRepositoryPaths?: string[];
  prohibitedRepositoryPaths?: string[];
  allowedTools?: string[];
  prohibitedActions?: string[];
  environments?: string[];
  dataClassifications?: string[];
  requiresHumanApprovalFor?: string[];
  timeBudgetMinutes?: number;
  tokenBudget?: number;
  notes?: string[];
}

export const orderConstraintsSchema = z.object({
  allowedRepositoryPaths: z.array(nonEmptyStringSchema).optional(),
  prohibitedRepositoryPaths: z.array(nonEmptyStringSchema).optional(),
  allowedTools: z.array(nonEmptyStringSchema).optional(),
  prohibitedActions: z.array(nonEmptyStringSchema).optional(),
  environments: z.array(nonEmptyStringSchema).optional(),
  dataClassifications: z.array(nonEmptyStringSchema).optional(),
  requiresHumanApprovalFor: z.array(nonEmptyStringSchema).optional(),
  timeBudgetMinutes: z.number().positive().optional(),
  tokenBudget: z.number().int().positive().optional(),
  notes: z.array(nonEmptyStringSchema).optional(),
});

export interface ApprovalRequirement {
  approvalId: string;
  description: string;
  approver: AgentRole | 'human';
  requiredBefore: 'START' | 'SIDE_EFFECT' | 'COMPLETE' | 'DEPLOY';
}

export const approvalRequirementSchema = z.object({
  approvalId: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  approver: z.union([organismAgentRoleSchema, z.literal('human')]),
  requiredBefore: z.enum(['START', 'SIDE_EFFECT', 'COMPLETE', 'DEPLOY']),
});

export const agentModeSchema = z.enum([
  'DORMANT',
  'DISCOVERY',
  'DEFINITION',
  'DESIGN',
  'PLANNING',
  'IMPLEMENTATION',
  'TESTING',
  'REVIEW',
  'REMEDIATION',
  'GATING',
  'DEPLOYMENT',
  'VALIDATION',
  'INCIDENT',
  'ROLLBACK',
  'MAINTENANCE',
  'BLOCKED',
  'PAUSED',
]);
export type AgentMode = z.infer<typeof agentModeSchema>;

export interface LoopPolicy {
  mode: AgentMode;
  reasoningDepth: 'LOW' | 'STANDARD' | 'HIGH';
  evidenceStrength: 'BASIC' | 'STANDARD' | 'STRICT' | 'REGULATED';
  requiredCollaborators: AgentRole[];
  optionalCollaborators: AgentRole[];
  maxParallelActions: number;
  maxIterations: number;
  maxRemediationRounds: number;
  requiredApprovals: ApprovalRequirement[];
  requiredGates: string[];
  onMissingInformation: 'ASK' | 'INVESTIGATE' | 'STATE_ASSUMPTION' | 'BLOCK';
  onConflict: 'RECONCILE' | 'ESCALATE' | 'DEFER' | 'BLOCK';
  onFailure: 'RETRY' | 'REMEDIATE' | 'REPLAN' | 'ROLLBACK' | 'ESCALATE' | 'FAIL';
  interruptionPolicy:
    | 'IMMEDIATE'
    | 'SAFE_BOUNDARY'
    | 'WORK_PACKAGE_BOUNDARY'
    | 'ITERATION_BOUNDARY';
}

export const loopPolicySchema = z.object({
  mode: agentModeSchema,
  reasoningDepth: z.enum(['LOW', 'STANDARD', 'HIGH']),
  evidenceStrength: z.enum(['BASIC', 'STANDARD', 'STRICT', 'REGULATED']),
  requiredCollaborators: z.array(organismAgentRoleSchema),
  optionalCollaborators: z.array(organismAgentRoleSchema),
  maxParallelActions: z.number().int().positive(),
  maxIterations: z.number().int().positive(),
  maxRemediationRounds: z.number().int().nonnegative(),
  requiredApprovals: z.array(approvalRequirementSchema),
  requiredGates: z.array(nonEmptyStringSchema),
  onMissingInformation: z.enum(['ASK', 'INVESTIGATE', 'STATE_ASSUMPTION', 'BLOCK']),
  onConflict: z.enum(['RECONCILE', 'ESCALATE', 'DEFER', 'BLOCK']),
  onFailure: z.enum(['RETRY', 'REMEDIATE', 'REPLAN', 'ROLLBACK', 'ESCALATE', 'FAIL']),
  interruptionPolicy: z.enum([
    'IMMEDIATE',
    'SAFE_BOUNDARY',
    'WORK_PACKAGE_BOUNDARY',
    'ITERATION_BOUNDARY',
  ]),
});

export interface AgentOrder {
  orderId: string;
  type: AgentOrderType;
  objective: string;
  rationale?: string;
  scope: ScopeBoundary;
  expectedOutputs: OutputRequirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  requiredEvidence: EvidenceRequirement[];
  dependencies: DependencyReference[];
  constraints: OrderConstraints;
  loopPolicy: LoopPolicy;
  authority: AuthorityGrant;
  sourceArtifactVersions: ArtifactReference[];
  priority: AgentPriority;
  deadline?: string;
  supersedesOrderId?: string;
  parentOrderId?: string;
}

export const agentOrderSchema = z.object({
  orderId: nonEmptyStringSchema,
  type: agentOrderTypeSchema,
  objective: nonEmptyStringSchema,
  rationale: nonEmptyStringSchema.optional(),
  scope: scopeBoundarySchema,
  expectedOutputs: z.array(outputRequirementSchema),
  acceptanceCriteria: z.array(acceptanceCriterionSchema),
  requiredEvidence: z.array(evidenceRequirementSchema),
  dependencies: z.array(dependencyReferenceSchema),
  constraints: orderConstraintsSchema,
  loopPolicy: loopPolicySchema,
  authority: authorityGrantSchema,
  sourceArtifactVersions: z.array(artifactReferenceSchema),
  priority: agentPrioritySchema,
  deadline: timestampSchema.optional(),
  supersedesOrderId: nonEmptyStringSchema.optional(),
  parentOrderId: nonEmptyStringSchema.optional(),
});

export const graphMutationOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ACTIVATE_AGENT'), role: organismAgentRoleSchema }),
  z.object({ type: z.literal('DEACTIVATE_AGENT'), role: organismAgentRoleSchema }),
  z.object({
    type: z.literal('ADD_EDGE'),
    edge: z.object({
      edgeId: nonEmptyStringSchema,
      from: organismAgentRoleSchema,
      to: organismAgentRoleSchema,
      relation: nonEmptyStringSchema,
    }),
  }),
  z.object({ type: z.literal('REMOVE_EDGE'), edgeId: nonEmptyStringSchema }),
  z.object({
    type: z.literal('CHANGE_PARALLELISM'),
    role: organismAgentRoleSchema,
    maximum: z.number().int().positive(),
  }),
  z.object({ type: z.literal('ADD_REQUIRED_GATE'), gatePolicyId: nonEmptyStringSchema }),
  z.object({
    type: z.literal('CHANGE_LOOP_POLICY'),
    role: organismAgentRoleSchema,
    loopPolicy: loopPolicySchema,
  }),
]);

export type GraphMutationOperation = z.infer<typeof graphMutationOperationSchema>;

export interface GraphMutation {
  mutationId: string;
  requestedBy: AgentAddress;
  baseGraphVersion: number;
  operations: GraphMutationOperation[];
  reason: string;
  effectiveAt: 'IMMEDIATE' | 'SAFE_BOUNDARY' | 'WORK_PACKAGE_END' | 'ITERATION_END';
}

export const graphMutationSchema = z.object({
  mutationId: nonEmptyStringSchema,
  requestedBy: agentAddressSchema,
  baseGraphVersion: z.number().int().nonnegative(),
  operations: z.array(graphMutationOperationSchema),
  reason: nonEmptyStringSchema,
  effectiveAt: z.enum(['IMMEDIATE', 'SAFE_BOUNDARY', 'WORK_PACKAGE_END', 'ITERATION_END']),
});

export const agentResultStatusSchema = z.enum([
  'COMPLETED',
  'PARTIAL',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
  'SUPERSEDED',
]);
export type AgentResultStatus = z.infer<typeof agentResultStatusSchema>;

export interface AgentResult {
  orderId: string;
  role: AgentRole;
  status: AgentResultStatus;
  summary: string;
  outputs: ArtifactReference[];
  evidence: EvidenceReference[];
  findings: Finding[];
  decisions: DecisionRecord[];
  assumptionsCreated: AssumptionRecord[];
  assumptionsInvalidated: string[];
  unresolvedQuestions: QuestionRecord[];
  limitations: LimitationRecord[];
  recommendedActions: RecommendedAction[];
  requestedGraphChanges?: GraphMutation[];
  sourceVersions: ArtifactReference[];
  stateVersion: number;
}

export const agentResultSchema = z.object({
  orderId: nonEmptyStringSchema,
  role: organismAgentRoleSchema,
  status: agentResultStatusSchema,
  summary: nonEmptyStringSchema,
  outputs: z.array(artifactReferenceSchema),
  evidence: z.array(evidenceReferenceSchema),
  findings: z.array(findingSchema),
  decisions: z.array(decisionRecordSchema),
  assumptionsCreated: z.array(assumptionRecordSchema),
  assumptionsInvalidated: z.array(nonEmptyStringSchema),
  unresolvedQuestions: z.array(questionRecordSchema),
  limitations: z.array(limitationRecordSchema),
  recommendedActions: z.array(recommendedActionSchema),
  requestedGraphChanges: z.array(graphMutationSchema).optional(),
  sourceVersions: z.array(artifactReferenceSchema),
  stateVersion: z.number().int().nonnegative(),
});

export const agentMessageKindSchema = z.enum([
  'COMMAND',
  'EVENT',
  'QUESTION',
  'RESPONSE',
  'DECISION',
  'EVIDENCE',
  'FINDING',
  'STATUS',
  'ESCALATION',
  'CONTROL',
]);
export type AgentMessageKind = z.infer<typeof agentMessageKindSchema>;

export const agentUrgencySchema = z.enum(['ROUTINE', 'EXPEDITED', 'IMMEDIATE']);
export type AgentUrgency = z.infer<typeof agentUrgencySchema>;

export interface AgentMessage<TPayload = unknown> {
  schemaVersion: '1.0';
  messageId: string;
  idempotencyKey: string;
  projectId: string;
  iterationId?: string;
  incrementId?: string;
  workPackageId?: string;
  correlationId: string;
  causationId?: string;
  conversationId?: string;
  sender: AgentAddress;
  recipients: AgentAddress[];
  kind: AgentMessageKind;
  name: string;
  priority: AgentPriority;
  urgency?: AgentUrgency;
  graphVersion: number;
  projectStateVersion: number;
  senderStateVersion: number;
  authority: AuthorityGrant;
  payload: TPayload;
  artifactRefs?: ArtifactReference[];
  evidenceRefs?: EvidenceReference[];
  decisionRefs?: DecisionReference[];
  replyTo?: {
    workflowId: string;
    signalName: string;
  };
  acknowledgementRequired: boolean;
  acknowledgeBy?: string;
  respondBy?: string;
  createdAt: string;
}

export const agentMessageSchema = z.object({
  schemaVersion: z.literal('1.0'),
  messageId: nonEmptyStringSchema,
  idempotencyKey: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  iterationId: nonEmptyStringSchema.optional(),
  incrementId: nonEmptyStringSchema.optional(),
  workPackageId: nonEmptyStringSchema.optional(),
  correlationId: nonEmptyStringSchema,
  causationId: nonEmptyStringSchema.optional(),
  conversationId: nonEmptyStringSchema.optional(),
  sender: agentAddressSchema,
  recipients: z.array(agentAddressSchema).min(1),
  kind: agentMessageKindSchema,
  name: nonEmptyStringSchema,
  priority: agentPrioritySchema,
  urgency: agentUrgencySchema.optional(),
  graphVersion: z.number().int().nonnegative(),
  projectStateVersion: z.number().int().nonnegative(),
  senderStateVersion: z.number().int().nonnegative(),
  authority: authorityGrantSchema,
  payload: z.unknown(),
  artifactRefs: z.array(artifactReferenceSchema).optional(),
  evidenceRefs: z.array(evidenceReferenceSchema).optional(),
  decisionRefs: z.array(decisionReferenceSchema).optional(),
  replyTo: z.object({
    workflowId: nonEmptyStringSchema,
    signalName: nonEmptyStringSchema,
  }).optional(),
  acknowledgementRequired: z.boolean(),
  acknowledgeBy: timestampSchema.optional(),
  respondBy: timestampSchema.optional(),
  createdAt: timestampSchema,
});

export type AgentRolePhase = 'shape' | 'design' | 'plan' | 'build' | 'assure';

export interface AgentRoleDefinition {
  role: AgentRole;
  label: string;
  icon: string;
  phase: AgentRolePhase;
  responsibility: string;
  owns: readonly string[];
  cannot: readonly string[];
  acceptedOrders: readonly AgentOrderType[];
  primaryArtifacts: readonly string[];
}

export const agentRoleDefinitions = [
  {
    role: 'manager',
    label: 'Manager',
    icon: '✦',
    phase: 'shape',
    responsibility: responsibilities.manager,
    owns: ['Delivery objective', 'Scope boundaries', 'Priority and authority', 'Active graph', 'Iteration lifecycle'],
    cannot: [
      'Invent unresolved business decisions',
      'Claim implementation or testing evidence',
      'Override deterministic gate policies without an authorized exception',
      'Approve its own technical claims as evidence',
    ],
    acceptedOrders: ['DEFINE_INCREMENT', 'INVESTIGATE', 'REPLAN', 'PAUSE', 'RESUME', 'CANCEL'],
    primaryArtifacts: [
      'Delivery Charter',
      'Scope Boundary',
      'Priority Model',
      'Authority Map',
      'Active Graph',
      'Iteration Charter',
      'Risk Register',
      'Decision Request',
      'Increment Closure Decision',
    ],
  },
  {
    role: 'requirements',
    label: 'Requirements',
    icon: '≡',
    phase: 'shape',
    responsibility: responsibilities.requirements,
    owns: ['Semantic contract', 'Requirement baseline', 'Acceptance criteria', 'Traceability', 'Assumptions and edge cases'],
    cannot: [
      'Decide customer priority',
      'Choose business policy',
      'Select architecture unless a requirement inherently constrains it',
      'Silently convert an assumption into a decision',
    ],
    acceptedOrders: ['ELABORATE_REQUIREMENTS', 'REMEDIATE', 'INVESTIGATE'],
    primaryArtifacts: [
      'Requirement Baseline',
      'Functional Requirements',
      'Nonfunctional Requirements',
      'Assumption Ledger',
      'Edge-case Catalog',
      'Acceptance Criteria',
      'Traceability Matrix',
      'Requirement Impact Report',
    ],
  },
  {
    role: 'product',
    label: 'Product',
    icon: '◎',
    phase: 'shape',
    responsibility: responsibilities.product,
    owns: ['Customer problem', 'Product increment', 'Outcome hypothesis', 'Value priorities', 'Success and guardrail signals'],
    cannot: [
      'Expand scope beyond Manager authority',
      'Convert an unapproved hypothesis into a requirement',
      'Claim customer value without validation evidence',
      'Override security, architecture, or gate constraints',
    ],
    acceptedOrders: ['DEFINE_INCREMENT', 'INVESTIGATE', 'REMEDIATE'],
    primaryArtifacts: [
      'Product Increment Brief',
      'Customer Problem Statement',
      'Outcome Hypothesis',
      'Priority Model',
      'Success Signals',
      'Guardrail Signals',
      'Product Continuation Decision',
    ],
  },
  {
    role: 'ux',
    label: 'UX',
    icon: '◇',
    phase: 'design',
    responsibility: responsibilities.ux,
    owns: ['User journeys', 'Information architecture', 'Interface states', 'Accessibility expectations', 'Interaction specification'],
    cannot: [
      'Change the product objective',
      'Select backend architecture solely for design convenience',
      'Waive accessibility expectations without approved authority',
    ],
    acceptedOrders: ['DESIGN_UX', 'REMEDIATE', 'INVESTIGATE'],
    primaryArtifacts: [
      'User Journey Map',
      'Information Architecture',
      'Interface State Matrix',
      'Accessibility Expectations',
      'Interaction Specification',
      'Prototype',
      'UX Conformance Findings',
    ],
  },
  {
    role: 'architecture',
    label: 'Architecture',
    icon: '⌘',
    phase: 'design',
    responsibility: responsibilities.architecture,
    owns: ['System boundaries', 'Component model', 'Interface ownership', 'Architecture decisions', 'Technical alternatives and risks'],
    cannot: [
      'Invent product requirements',
      'Claim implementation feasibility without supporting evidence',
      'Override Data or Security domain controls without explicit resolution',
    ],
    acceptedOrders: ['DESIGN_ARCHITECTURE', 'INVESTIGATE', 'REMEDIATE'],
    primaryArtifacts: [
      'System Context',
      'Component Model',
      'Boundary Definitions',
      'Interface Contracts',
      'Architecture Decision Record',
      'Alternative Analysis',
      'Architecture Risk Report',
      'Conformance Findings',
    ],
  },
  {
    role: 'data',
    label: 'Data',
    icon: '▦',
    phase: 'design',
    responsibility: responsibilities.data,
    owns: ['Data contracts', 'Consistency', 'Migrations', 'Lineage and retention', 'Data classification and quality'],
    cannot: [
      'Define business ownership without authorization',
      'Waive privacy or security requirements',
      'Claim migration success without execution evidence',
    ],
    acceptedOrders: ['DESIGN_DATA', 'INVESTIGATE', 'REMEDIATE'],
    primaryArtifacts: [
      'Entity Model',
      'Schema Definitions',
      'Data Contracts',
      'Consistency Rules',
      'Migration Plan',
      'Rollback Plan',
      'Lineage Graph',
      'Retention Policy',
      'Data Classification',
      'Data-quality Requirements',
    ],
  },
  {
    role: 'security',
    label: 'Security',
    icon: '⛉',
    phase: 'design',
    responsibility: responsibilities.security,
    owns: ['Threat model', 'Trust boundaries', 'Security controls', 'Permissions and secrets', 'Residual risk'],
    cannot: [
      'Approve its own policy exception',
      'Invent evidence that a control works',
      'Silently accept residual risk owned by another authority',
    ],
    acceptedOrders: ['THREAT_MODEL', 'INVESTIGATE', 'REMEDIATE'],
    primaryArtifacts: [
      'Threat Model',
      'Trust-boundary Model',
      'Control Matrix',
      'Permission Model',
      'Secret-handling Rules',
      'Dependency Risk Report',
      'Agent and Prompt Security Report',
      'Residual-risk Statement',
      'Security Findings',
    ],
  },
  {
    role: 'planner',
    label: 'Planner',
    icon: '↗',
    phase: 'plan',
    responsibility: responsibilities.planner,
    owns: ['Work packages', 'Dependency ordering', 'Acceptance and evidence mapping', 'Delegated permissions', 'Delivery risk routes'],
    cannot: [
      'Change product scope',
      'Remove requirements to simplify implementation',
      'Waive security, data, test, or gate obligations',
    ],
    acceptedOrders: ['PLAN_WORK', 'REPLAN', 'REMEDIATE', 'INVESTIGATE'],
    primaryArtifacts: [
      'Plan Graph',
      'Work Packages',
      'Dependency Graph',
      'Acceptance Mapping',
      'Evidence Mapping',
      'Test Obligations',
      'Permission Requirements',
      'Risk and Rollback Routes',
    ],
  },
  {
    role: 'builder',
    label: 'Builder',
    icon: '⌨',
    phase: 'build',
    responsibility: responsibilities.builder,
    owns: ['Scoped source changes', 'Implementation submission', 'Reproduction instructions', 'Reported limitations and blockers'],
    cannot: [
      'Change requirements silently',
      'Waive tests',
      'Approve its own work',
      'Invent test, build, or runtime results',
      'Claim an Activity executed without an execution result',
    ],
    acceptedOrders: ['IMPLEMENT', 'REMEDIATE', 'INVESTIGATE'],
    primaryArtifacts: [
      'Implementation Submission',
      'Changed Behavior Summary',
      'Source Changes',
      'Configuration Changes',
      'Commit or Pull Request',
      'Actual Test Evidence',
      'Build Evidence',
      'Limitations',
      'Blockers',
      'Reproduction Instructions',
    ],
  },
  {
    role: 'test',
    label: 'Test',
    icon: '✓',
    phase: 'assure',
    responsibility: responsibilities.test,
    owns: ['Independent test design', 'Requirement-to-test mapping', 'Execution evidence', 'Defects and regression risk', 'Test verdict'],
    cannot: [
      'Change requirements to make tests pass',
      'Approve architecture exceptions',
      'Treat absence of a failing test as proof of correctness',
    ],
    acceptedOrders: ['DESIGN_TESTS', 'EXECUTE_TESTS', 'INVESTIGATE', 'REMEDIATE'],
    primaryArtifacts: [
      'Independent Test Plan',
      'Test Cases',
      'Requirement-to-test Mapping',
      'Execution Evidence',
      'Defect Reports',
      'Regression Report',
      'Untested-risk Statement',
      'Test Verdict',
    ],
  },
  {
    role: 'reviewer',
    label: 'Reviewer',
    icon: '◉',
    phase: 'assure',
    responsibility: responsibilities.reviewer,
    owns: ['Independent review', 'Severity-ranked findings', 'Coverage assessment', 'Review decision', 'Scoped remediation orders'],
    cannot: [
      'Directly modify the candidate under review',
      'Waive gate rules',
      'Expand product scope through review findings',
      'Rely solely on the Builder narrative',
    ],
    acceptedOrders: ['REVIEW', 'INVESTIGATE'],
    primaryArtifacts: [
      'Review Report',
      'Severity-ranked Findings',
      'Requirement Coverage',
      'Evidence Coverage',
      'Review Decision',
      'Remediation Orders',
      'Finding Dispute Record',
    ],
  },
  {
    role: 'gate',
    label: 'Gate',
    icon: '◆',
    phase: 'assure',
    responsibility: responsibilities.gate,
    owns: ['Deterministic gate evaluation', 'Missing-evidence assessment', 'Release authorization', 'Authorization revocation'],
    cannot: [
      'Manufacture missing evidence',
      'Modify the candidate',
      'Accept an unsupported verbal assurance',
      'Approve its own exception',
      'Reinterpret a deterministic hard rule as optional',
    ],
    acceptedOrders: ['EVALUATE_GATE'],
    primaryArtifacts: [
      'Gate Decision',
      'Missing Evidence Report',
      'Remediation Order',
      'Exception Request',
      'Signed Release Authorization',
      'Authorization Revocation',
    ],
  },
  {
    role: 'deployment',
    label: 'Deployment',
    icon: '⇧',
    phase: 'assure',
    responsibility: responsibilities.deployment,
    owns: ['Release plan', 'Rollout and migration execution', 'Observed health', 'Rollback', 'Incident declaration'],
    cannot: [
      'Deploy an unauthorized artifact',
      'Change implementation during deployment',
      'Waive gate conditions',
      'Claim health without observed metrics',
      'Silently substitute a different artifact',
    ],
    acceptedOrders: ['DEPLOY', 'ROLLBACK', 'INVESTIGATE'],
    primaryArtifacts: [
      'Release Plan',
      'Deployment Record',
      'Migration Evidence',
      'Smoke-test Evidence',
      'Health Comparison',
      'Rollout Stage Record',
      'Rollback Record',
      'Incident Record',
    ],
  },
  {
    role: 'validation',
    label: 'Validation',
    icon: '≈',
    phase: 'assure',
    responsibility: responsibilities.validation,
    owns: ['Realistic outcome scenarios', 'Outcome evidence', 'Success and guardrail evaluation', 'Validation decision'],
    cannot: [
      'Claim business success from technical test results alone',
      'Redefine success after observing results without recording the change',
      'Silently reinterpret the original product hypothesis',
      'Authorize deployment',
    ],
    acceptedOrders: ['VALIDATE_OUTCOME', 'INVESTIGATE'],
    primaryArtifacts: [
      'Outcome Validation Plan',
      'Realistic Scenario Set',
      'Baseline',
      'Outcome Evidence',
      'Success-signal Evaluation',
      'Guardrail Evaluation',
      'Outcome-gap Report',
      'Validation Decision',
    ],
  },
] as const satisfies readonly AgentRoleDefinition[];

export const agentRelationshipKindSchema = z.enum([
  'directs',
  'collaborates',
  'requests',
  'hands_off',
  'remediates',
  'authorizes',
  'reports',
]);
export type AgentRelationshipKind = z.infer<typeof agentRelationshipKindSchema>;

export interface AgentRelationship {
  id: string;
  from: AgentRole;
  to: AgentRole;
  kind: AgentRelationshipKind;
  label: string;
  description: string;
  bidirectional?: boolean;
}

export const agentRelationshipSchema = z.object({
  id: nonEmptyStringSchema,
  from: organismAgentRoleSchema,
  to: organismAgentRoleSchema,
  kind: agentRelationshipKindSchema,
  label: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  bidirectional: z.boolean().optional(),
});

/** Permitted communication paths. These are capabilities, not sequencing rules. */
export const agentRelationshipCatalog = [
  { id: 'manager-product', from: 'manager', to: 'product', kind: 'directs', label: 'Sets product direction', description: 'Delegates increment definition and receives the proposed value boundary.', bidirectional: true },
  { id: 'manager-requirements', from: 'manager', to: 'requirements', kind: 'directs', label: 'Sets definition boundary', description: 'Requests a traceable requirement baseline and receives ambiguity escalations.', bidirectional: true },
  { id: 'manager-ux', from: 'manager', to: 'ux', kind: 'directs', label: 'Commissions experience design', description: 'Requests a complete interaction model within the accepted scope.', bidirectional: true },
  { id: 'manager-architecture', from: 'manager', to: 'architecture', kind: 'directs', label: 'Commissions technical design', description: 'Requests system boundaries and receives technical risk and decision needs.', bidirectional: true },
  { id: 'manager-data', from: 'manager', to: 'data', kind: 'directs', label: 'Commissions data design', description: 'Requests data and migration design and receives integrity risks.', bidirectional: true },
  { id: 'manager-security', from: 'manager', to: 'security', kind: 'directs', label: 'Commissions threat analysis', description: 'Requests threat modeling and receives unacceptable-risk escalations.', bidirectional: true },
  { id: 'manager-planner', from: 'manager', to: 'planner', kind: 'directs', label: 'Requests an execution plan', description: 'Delegates bounded planning and accepts, rejects, or revises the proposed plan.', bidirectional: true },
  { id: 'manager-builder', from: 'manager', to: 'builder', kind: 'directs', label: 'Authorizes scoped implementation', description: 'Delegates explicitly bounded implementation or emergency work.', bidirectional: true },
  { id: 'manager-test', from: 'manager', to: 'test', kind: 'directs', label: 'Requests independent testing', description: 'Delegates validation while preserving Test independence.', bidirectional: true },
  { id: 'manager-reviewer', from: 'manager', to: 'reviewer', kind: 'directs', label: 'Requests independent review', description: 'Delegates review and receives an unambiguous decision.', bidirectional: true },
  { id: 'manager-gate', from: 'manager', to: 'gate', kind: 'directs', label: 'Requests readiness evaluation', description: 'Requests deterministic gate evaluation without overriding the result.', bidirectional: true },
  { id: 'manager-deployment', from: 'manager', to: 'deployment', kind: 'directs', label: 'Requests controlled rollout', description: 'Delegates rollout preparation or execution under a release authorization.', bidirectional: true },
  { id: 'manager-validation', from: 'manager', to: 'validation', kind: 'directs', label: 'Requests outcome validation', description: 'Requests realistic outcome assessment and receives closure or iteration advice.', bidirectional: true },

  { id: 'product-requirements', from: 'product', to: 'requirements', kind: 'collaborates', label: 'Turns value into a contract', description: 'Product supplies intent while Requirements exposes ambiguity and formalizes accepted behavior.', bidirectional: true },
  { id: 'product-ux', from: 'product', to: 'ux', kind: 'collaborates', label: 'Shapes the customer journey', description: 'They reconcile customer value, usability, and increment complexity.', bidirectional: true },
  { id: 'product-validation', from: 'product', to: 'validation', kind: 'requests', label: 'Tests the outcome hypothesis', description: 'Product requests realistic validation and receives evidence about actual value.', bidirectional: true },
  { id: 'product-architecture', from: 'product', to: 'architecture', kind: 'requests', label: 'Checks product feasibility', description: 'Architecture reports constraints that materially affect the increment boundary.', bidirectional: true },

  { id: 'requirements-ux', from: 'requirements', to: 'ux', kind: 'collaborates', label: 'Completes visible behavior', description: 'They reconcile behavioral requirements, states, edge cases, and accessibility.', bidirectional: true },
  { id: 'requirements-architecture', from: 'requirements', to: 'architecture', kind: 'collaborates', label: 'Reconciles intent and feasibility', description: 'Architecture clarifies constraints without changing business intent.', bidirectional: true },
  { id: 'requirements-data', from: 'requirements', to: 'data', kind: 'requests', label: 'Clarifies data implications', description: 'They resolve ownership, retention, consistency, and data-sensitive requirements.', bidirectional: true },
  { id: 'requirements-security', from: 'requirements', to: 'security', kind: 'requests', label: 'Clarifies security obligations', description: 'Security turns threat and control needs into explicit constraints.', bidirectional: true },
  { id: 'requirements-planner', from: 'requirements', to: 'planner', kind: 'requests', label: 'Maps requirements to work', description: 'They keep every accepted requirement represented in the plan.', bidirectional: true },
  { id: 'requirements-test', from: 'requirements', to: 'test', kind: 'requests', label: 'Maps criteria to tests', description: 'Test exposes untestable criteria and returns independent coverage.', bidirectional: true },
  { id: 'requirements-reviewer', from: 'requirements', to: 'reviewer', kind: 'requests', label: 'Checks traceability', description: 'Reviewer verifies that the candidate and evidence trace to the baseline.', bidirectional: true },
  { id: 'requirements-validation', from: 'requirements', to: 'validation', kind: 'requests', label: 'Builds realistic scenarios', description: 'Validation exposes missing outcome cases or incorrect success criteria.', bidirectional: true },

  { id: 'ux-architecture', from: 'ux', to: 'architecture', kind: 'collaborates', label: 'Reconciles interaction constraints', description: 'They align interface behavior with system boundaries and runtime behavior.', bidirectional: true },
  { id: 'ux-planner', from: 'ux', to: 'planner', kind: 'requests', label: 'Makes UX work executable', description: 'Planner maps journeys, states, and prototypes into bounded work.', bidirectional: true },
  { id: 'ux-test', from: 'ux', to: 'test', kind: 'requests', label: 'Validates interface states', description: 'Test covers accessibility and success, empty, error, loading, and recovery states.', bidirectional: true },
  { id: 'ux-validation', from: 'ux', to: 'validation', kind: 'collaborates', label: 'Evaluates realistic usability', description: 'Validation reports whether real users can achieve the intended outcome.', bidirectional: true },

  { id: 'architecture-data', from: 'architecture', to: 'data', kind: 'collaborates', label: 'Aligns system and data boundaries', description: 'They resolve ownership, persistence, consistency, and migration boundaries.', bidirectional: true },
  { id: 'architecture-security', from: 'architecture', to: 'security', kind: 'collaborates', label: 'Places security controls', description: 'They reconcile trust boundaries, interfaces, and control placement.', bidirectional: true },
  { id: 'architecture-planner', from: 'architecture', to: 'planner', kind: 'requests', label: 'Maps technical dependencies', description: 'Planner incorporates system boundaries, sequencing, and technical spikes.', bidirectional: true },
  { id: 'architecture-builder', from: 'architecture', to: 'builder', kind: 'requests', label: 'Guides technical implementation', description: 'Builder executes spikes or remediation and reports boundary conflicts.', bidirectional: true },
  { id: 'architecture-reviewer', from: 'architecture', to: 'reviewer', kind: 'requests', label: 'Checks architecture conformance', description: 'Reviewer independently verifies the candidate against technical decisions.', bidirectional: true },

  { id: 'data-security', from: 'data', to: 'security', kind: 'collaborates', label: 'Protects sensitive data', description: 'They resolve classification, retention, privacy, and exfiltration controls.', bidirectional: true },
  { id: 'data-planner', from: 'data', to: 'planner', kind: 'requests', label: 'Plans data change safely', description: 'Planner carries migration, integrity, rehearsal, and rollback obligations.', bidirectional: true },
  { id: 'data-builder', from: 'data', to: 'builder', kind: 'requests', label: 'Implements data contracts', description: 'Builder implements schemas and migrations and reports feasibility issues.', bidirectional: true },
  { id: 'data-test', from: 'data', to: 'test', kind: 'requests', label: 'Validates data integrity', description: 'Test executes data-quality, migration, and rollback validation.', bidirectional: true },
  { id: 'data-deployment', from: 'data', to: 'deployment', kind: 'requests', label: 'Coordinates migration rollout', description: 'Deployment executes authorized migration stages and returns evidence.', bidirectional: true },

  { id: 'security-planner', from: 'security', to: 'planner', kind: 'requests', label: 'Plans required controls', description: 'Planner carries security work, permissions, evidence, and gates into execution.', bidirectional: true },
  { id: 'security-builder', from: 'security', to: 'builder', kind: 'remediates', label: 'Remediates security findings', description: 'Security scopes required controls; Builder supplies an implementation submission.', bidirectional: true },
  { id: 'security-test', from: 'security', to: 'test', kind: 'requests', label: 'Verifies security controls', description: 'Test executes independent security checks and preserves evidence.', bidirectional: true },
  { id: 'security-reviewer', from: 'security', to: 'reviewer', kind: 'requests', label: 'Reviews sensitive changes', description: 'Reviewer independently examines security-sensitive implementation claims.', bidirectional: true },
  { id: 'security-gate', from: 'security', to: 'gate', kind: 'hands_off', label: 'Supplies security readiness', description: 'Security submits findings, control evidence, and residual risk to Gate.', bidirectional: true },
  { id: 'security-deployment', from: 'security', to: 'deployment', kind: 'requests', label: 'Applies operational controls', description: 'Deployment applies approved release-time controls and reports security events.', bidirectional: true },

  { id: 'planner-builder', from: 'planner', to: 'builder', kind: 'hands_off', label: 'Hands off implementation work', description: 'Planner delegates bounded work packages with scope, evidence, and permissions.', bidirectional: true },
  { id: 'planner-test', from: 'planner', to: 'test', kind: 'hands_off', label: 'Hands off test work', description: 'Planner delegates independent test-design or execution packages.', bidirectional: true },
  { id: 'planner-reviewer', from: 'planner', to: 'reviewer', kind: 'hands_off', label: 'Hands off review scope', description: 'Planner supplies the candidate boundary and review obligations.', bidirectional: true },
  { id: 'planner-deployment', from: 'planner', to: 'deployment', kind: 'hands_off', label: 'Hands off rollout preparation', description: 'Planner supplies release preparation, migration, and rollback work.', bidirectional: true },

  { id: 'builder-test', from: 'builder', to: 'test', kind: 'collaborates', label: 'Implementation-validation loop', description: 'Builder submits reproducible work; Test reports defects and independent evidence.', bidirectional: true },
  { id: 'builder-reviewer', from: 'builder', to: 'reviewer', kind: 'hands_off', label: 'Submits work for review', description: 'Builder hands off the complete candidate without controlling the decision.', bidirectional: true },
  { id: 'reviewer-builder', from: 'reviewer', to: 'builder', kind: 'remediates', label: 'Returns implementation findings', description: 'Reviewer issues bounded, severity-ranked remediation to Builder.', bidirectional: true },
  { id: 'test-reviewer', from: 'test', to: 'reviewer', kind: 'hands_off', label: 'Supplies independent test evidence', description: 'Reviewer consumes the verdict, coverage, defects, and untested-risk statement.', bidirectional: true },
  { id: 'reviewer-gate', from: 'reviewer', to: 'gate', kind: 'hands_off', label: 'Submits the review decision', description: 'Gate receives independent findings, coverage, and the final review decision.', bidirectional: true },

  { id: 'gate-deployment', from: 'gate', to: 'deployment', kind: 'authorizes', label: 'Authorizes an immutable release', description: 'Gate identifies the exact artifact Deployment may release and may revoke it.', bidirectional: true },
  { id: 'gate-builder', from: 'gate', to: 'builder', kind: 'remediates', label: 'Requests implementation proof', description: 'Missing implementation evidence or a failed rule returns to Builder.', bidirectional: true },
  { id: 'gate-test', from: 'gate', to: 'test', kind: 'remediates', label: 'Requests additional test evidence', description: 'Missing or stale validation proof returns to Test.', bidirectional: true },
  { id: 'gate-requirements', from: 'gate', to: 'requirements', kind: 'remediates', label: 'Requests traceability repair', description: 'Requirement or acceptance gaps return to their accountable owner.', bidirectional: true },
  { id: 'gate-architecture', from: 'gate', to: 'architecture', kind: 'remediates', label: 'Requests architecture proof', description: 'Decision or conformance gaps return to Architecture.', bidirectional: true },
  { id: 'gate-data', from: 'gate', to: 'data', kind: 'remediates', label: 'Requests data integrity proof', description: 'Migration or integrity gaps return to Data.', bidirectional: true },
  { id: 'gate-security', from: 'gate', to: 'security', kind: 'remediates', label: 'Requests security proof', description: 'Security evidence and residual-risk gaps return to Security.', bidirectional: true },

  { id: 'deployment-test', from: 'deployment', to: 'test', kind: 'requests', label: 'Runs release smoke tests', description: 'Test verifies the deployed artifact in the target environment.', bidirectional: true },
  { id: 'deployment-validation', from: 'deployment', to: 'validation', kind: 'hands_off', label: 'Hands off the live outcome', description: 'Validation evaluates realistic behavior and outcome signals after rollout.', bidirectional: true },
  { id: 'deployment-builder', from: 'deployment', to: 'builder', kind: 'remediates', label: 'Reports runtime defects', description: 'Deployment requests an authorized investigation or minimal hotfix.', bidirectional: true },
  { id: 'deployment-gate', from: 'deployment', to: 'gate', kind: 'reports', label: 'Reports release health', description: 'Changed candidates or emergency conditions return to Gate for evaluation.', bidirectional: true },

  { id: 'validation-manager', from: 'validation', to: 'manager', kind: 'reports', label: 'Reports the real-world outcome', description: 'Manager uses outcome evidence to close, revise, extend, or roll back the increment.' },
  { id: 'validation-product', from: 'validation', to: 'product', kind: 'reports', label: 'Reports hypothesis results', description: 'Product learns whether observed value matched the expected outcome.' },
  { id: 'validation-requirements', from: 'validation', to: 'requirements', kind: 'reports', label: 'Reports scenario gaps', description: 'Requirements receives realistic cases or success criteria that need correction.' },
  { id: 'validation-deployment', from: 'validation', to: 'deployment', kind: 'reports', label: 'Reports harm or recovery', description: 'Deployment receives a pause, containment, or rollback recommendation.' },
] as const satisfies readonly AgentRelationship[];

export const agentScenarioKindSchema = z.enum(['feature', 'bugfix', 'incident', 'discovery']);
export type AgentScenarioKind = z.infer<typeof agentScenarioKindSchema>;

export interface AgentScenarioStage {
  id: string;
  label: string;
  description: string;
  mode: AgentMode;
  roles: readonly AgentRole[];
  conditionalRoles?: readonly AgentRole[];
  parallel: boolean;
}

export interface AgentScenarioDefinition {
  id: AgentScenarioKind;
  label: string;
  description: string;
  activeRoles: readonly AgentRole[];
  conditionalRoles: readonly AgentRole[];
  dormantRoles: readonly AgentRole[];
  priorityPrinciples: readonly string[];
  stages: readonly AgentScenarioStage[];
}

/**
 * Named graph topologies used to explain which parts of the organism wake up,
 * which may be pulled in, and how work converges for common delivery scenarios.
 */
export const agentScenarioDefinitions = [
  {
    id: 'feature',
    label: 'Feature delivery',
    description: 'A complete definition-to-outcome loop for a new customer-facing increment.',
    activeRoles: organismAgentRoles,
    conditionalRoles: [],
    dormantRoles: [],
    priorityPrinciples: [
      'Define the smallest useful increment',
      'Converge product, requirement, experience, technical, data, and security intent',
      'Keep implementation, testing, review, and gate decisions independent',
      'Validate the real-world outcome after a controlled release',
    ],
    stages: [
      { id: 'feature-charter', label: 'Set the charter', description: 'Define objective, scope, authority, priorities, and success boundaries.', mode: 'DEFINITION', roles: ['manager'], parallel: false },
      { id: 'feature-increment', label: 'Define the increment', description: 'Converge the smallest useful increment with a traceable behavioral contract.', mode: 'DEFINITION', roles: ['product', 'requirements'], parallel: true },
      { id: 'feature-design', label: 'Design in parallel', description: 'Resolve user experience, system, data, and security boundaries together.', mode: 'DESIGN', roles: ['ux', 'architecture', 'data', 'security'], parallel: true },
      { id: 'feature-plan', label: 'Plan bounded work', description: 'Create dependency-ordered packages with tests, evidence, risks, and permissions.', mode: 'PLANNING', roles: ['planner'], parallel: false },
      { id: 'feature-build-test', label: 'Build and validate', description: 'Implement bounded packages and continuously return reproducible defects for remediation.', mode: 'IMPLEMENTATION', roles: ['builder', 'test'], parallel: true },
      { id: 'feature-review', label: 'Review independently', description: 'Assess the complete submission and issue severity-ranked findings.', mode: 'REVIEW', roles: ['reviewer'], parallel: false },
      { id: 'feature-gate', label: 'Apply the gate', description: 'Use deterministic rules to authorize the exact immutable candidate or return missing proof.', mode: 'GATING', roles: ['gate'], conditionalRoles: ['builder', 'test', 'requirements', 'architecture', 'data', 'security'], parallel: false },
      { id: 'feature-release', label: 'Release progressively', description: 'Roll out, observe, smoke-test, and retain a safe rollback route.', mode: 'DEPLOYMENT', roles: ['deployment'], conditionalRoles: ['test'], parallel: false },
      { id: 'feature-outcome', label: 'Validate the outcome', description: 'Evaluate realistic user and business outcomes and recommend closure or another iteration.', mode: 'VALIDATION', roles: ['validation'], conditionalRoles: ['product', 'requirements', 'manager'], parallel: false },
    ],
  },
  {
    id: 'bugfix',
    label: 'Bug fix',
    description: 'A reproduction-first repair loop with an explicit expected behavior and regression boundary.',
    activeRoles: ['manager', 'requirements', 'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation'],
    conditionalRoles: ['architecture', 'data', 'security', 'ux', 'product'],
    dormantRoles: [],
    priorityPrinciples: [
      'Reproduce before changing the candidate',
      'Define expected behavior and the regression boundary',
      'Keep the repair bounded',
      'Verify both the defect and affected regressions',
    ],
    stages: [
      { id: 'bugfix-boundary', label: 'Define expected behavior', description: 'State the failure, correct behavior, affected scope, and regression boundary.', mode: 'DEFINITION', roles: ['manager', 'requirements'], conditionalRoles: ['product', 'ux'], parallel: true },
      { id: 'bugfix-reproduce', label: 'Reproduce independently', description: 'Create reliable reproduction evidence before implementation begins.', mode: 'TESTING', roles: ['test'], parallel: false },
      { id: 'bugfix-assess', label: 'Assess domain impact', description: 'Activate specialist analysis when the defect crosses system, data, or trust boundaries.', mode: 'DESIGN', roles: [], conditionalRoles: ['architecture', 'data', 'security'], parallel: true },
      { id: 'bugfix-plan', label: 'Plan the repair', description: 'Create a bounded repair package and explicit verification obligations.', mode: 'PLANNING', roles: ['planner'], parallel: false },
      { id: 'bugfix-repair', label: 'Repair and verify', description: 'Implement the repair, retest the reproduction, and cover regressions.', mode: 'REMEDIATION', roles: ['builder', 'test'], parallel: true },
      { id: 'bugfix-assure', label: 'Review and gate', description: 'Independently review the repair and apply completion rules.', mode: 'REVIEW', roles: ['reviewer', 'gate'], parallel: false },
      { id: 'bugfix-release', label: 'Release and confirm', description: 'Deploy the authorized repair and confirm realistic recovery.', mode: 'DEPLOYMENT', roles: ['deployment', 'validation'], parallel: false },
    ],
  },
  {
    id: 'incident',
    label: 'Production incident',
    description: 'A containment-first topology for restoring safety while preserving evidence and independent assurance.',
    activeRoles: ['manager', 'requirements', 'architecture', 'data', 'security', 'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation'],
    conditionalRoles: ['product', 'ux'],
    dormantRoles: [],
    priorityPrinciples: [
      'Contain harm',
      'Restore safe service',
      'Preserve evidence',
      'Prefer the smallest safe repair',
      'Verify independently',
      'Record root cause and prevention work',
    ],
    stages: [
      { id: 'incident-detect', label: 'Detect and declare', description: 'Turn observed harm into a controlled incident with explicit authority.', mode: 'INCIDENT', roles: ['deployment', 'validation', 'manager'], parallel: true },
      { id: 'incident-contain', label: 'Contain harm', description: 'Pause rollout, isolate impact, or roll back while preserving evidence.', mode: 'ROLLBACK', roles: ['deployment', 'manager'], conditionalRoles: ['security', 'data'], parallel: true },
      { id: 'incident-investigate', label: 'Investigate in parallel', description: 'Reproduce the failure and assess exposure, integrity, and systemic cause.', mode: 'INCIDENT', roles: ['security', 'test', 'architecture', 'data'], parallel: true },
      { id: 'incident-repair', label: 'Prepare the minimal repair', description: 'Build, test, and independently review the smallest safe hotfix.', mode: 'REMEDIATION', roles: ['builder', 'test', 'reviewer'], parallel: true },
      { id: 'incident-gate', label: 'Apply emergency policy', description: 'Evaluate the immutable repair under the authorized emergency gate.', mode: 'GATING', roles: ['gate'], conditionalRoles: ['security', 'data'], parallel: false },
      { id: 'incident-recover', label: 'Roll out recovery', description: 'Deploy the repair progressively and observe health and guardrails.', mode: 'DEPLOYMENT', roles: ['deployment'], conditionalRoles: ['test'], parallel: false },
      { id: 'incident-confirm', label: 'Confirm recovery', description: 'Validate that harm stopped and intended outcomes recovered.', mode: 'VALIDATION', roles: ['validation'], parallel: false },
      { id: 'incident-prevent', label: 'Record prevention work', description: 'Capture corrective requirements and create root-cause prevention packages.', mode: 'PLANNING', roles: ['requirements', 'planner', 'manager'], parallel: true },
    ],
  },
  {
    id: 'discovery',
    label: 'Discovery',
    description: 'A learning topology that tests the problem and outcome hypothesis before full delivery is authorized.',
    activeRoles: ['manager', 'requirements', 'product', 'ux', 'validation'],
    conditionalRoles: ['architecture'],
    dormantRoles: ['data', 'security', 'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment'],
    priorityPrinciples: [
      'Reduce product and user uncertainty',
      'Keep hypotheses distinct from accepted requirements',
      'Use realistic scenarios and observable evidence',
      'Do not activate delivery work unless a technical experiment is authorized',
    ],
    stages: [
      { id: 'discovery-charter', label: 'Frame the question', description: 'Define the learning objective, boundaries, authority, and decision it will inform.', mode: 'DISCOVERY', roles: ['manager'], parallel: false },
      { id: 'discovery-explore', label: 'Explore in parallel', description: 'Develop the hypothesis, behavioral questions, experience options, and realistic scenarios.', mode: 'DISCOVERY', roles: ['product', 'requirements', 'ux', 'validation'], conditionalRoles: ['architecture'], parallel: true },
      { id: 'discovery-converge', label: 'Converge on evidence', description: 'Reconcile findings, assumptions, constraints, and outcome evidence.', mode: 'DEFINITION', roles: ['product', 'requirements', 'ux', 'validation'], parallel: true },
      { id: 'discovery-decide', label: 'Choose the next move', description: 'Continue discovery, define an increment, stop, or authorize a bounded experiment.', mode: 'DEFINITION', roles: ['manager', 'product'], parallel: false },
    ],
  },
] as const satisfies readonly AgentScenarioDefinition[];

/** Alias retained for consumers that describe the catalog in activation terms. */
export const agentActivationScenarios = agentScenarioDefinitions;

export type AgentInteractionParty = AgentRole | 'human' | 'system' | 'project';
export type AgentInteractionKind =
  | 'order'
  | 'status'
  | 'handoff'
  | 'evidence'
  | 'finding'
  | 'decision'
  | 'control';
export type AgentInteractionStatus =
  | 'pending'
  | 'acknowledged'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'rejected';

/** A compact, human-readable projection of protocol traffic for the UI. */
export interface AgentInteraction {
  id: string;
  messageId?: string;
  correlationId?: string;
  iterationNumber: number;
  from: AgentInteractionParty;
  to: AgentInteractionParty[];
  kind: AgentInteractionKind;
  name: string;
  summary: string;
  status: AgentInteractionStatus;
  createdAt: string;
  artifactRefs?: ArtifactReference[];
  live?: boolean;
}

const agentInteractionPartySchema = z.union([
  organismAgentRoleSchema,
  z.enum(['human', 'system', 'project']),
]);

export const agentInteractionSchema = z.object({
  id: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema.optional(),
  correlationId: nonEmptyStringSchema.optional(),
  iterationNumber: z.number().int().positive(),
  from: agentInteractionPartySchema,
  to: z.array(agentInteractionPartySchema).min(1),
  kind: z.enum(['order', 'status', 'handoff', 'evidence', 'finding', 'decision', 'control']),
  name: nonEmptyStringSchema,
  summary: nonEmptyStringSchema,
  status: z.enum(['pending', 'acknowledged', 'in_progress', 'completed', 'blocked', 'rejected']),
  createdAt: timestampSchema,
  artifactRefs: z.array(artifactReferenceSchema).optional(),
  live: z.boolean().optional(),
});
