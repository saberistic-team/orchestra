import { z } from 'zod';
import { organismAgentRoles } from './agent-organism.js';

const nonBlank = z.string().trim().min(1);
const activityName = z.string().regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u);
const capabilityVersion = z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u);

export const dynamicExecutionProtocolVersionSchema = z.literal('1');
export const dynamicJsonObjectSchema = z.record(z.string(), z.json());

export const dynamicCapabilityDescriptorSchema = z.object({
  protocolVersion: dynamicExecutionProtocolVersionSchema,
  name: activityName,
  version: capabilityVersion,
  description: nonBlank.max(2_000),
  inputSchema: dynamicJsonObjectSchema,
  outputSchema: dynamicJsonObjectSchema,
  requiredAuthorityAction: nonBlank.max(200),
  effect: z.enum(['read_only', 'mutating']),
  idempotency: z.object({
    mode: z.enum(['intrinsic', 'operation_key']),
    conflictPolicy: z.enum(['reuse_result', 'reject']),
  }).strict(),
  timeoutMs: z.number().int().positive().max(3_600_000),
  retryPolicy: z.object({
    maximumAttempts: z.number().int().positive().max(10),
    initialBackoffMs: z.number().int().nonnegative().max(300_000),
    maximumBackoffMs: z.number().int().positive().max(900_000),
  }).strict(),
  dataClassifications: z.array(nonBlank.max(100)).max(20),
  maxResultBytes: z.number().int().positive().max(10_000_000),
  approval: z.enum(['never', 'required']),
  pathArguments: z.array(nonBlank.max(100)).max(20).default([]),
  mutationScopeArgument: nonBlank.max(100).optional(),
}).strict();
export type DynamicCapabilityDescriptor = z.infer<typeof dynamicCapabilityDescriptorSchema>;

export const dynamicPlannedActionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/u),
  activity: activityName,
  activityVersion: capabilityVersion,
  arguments: dynamicJsonObjectSchema,
  dependsOn: z.array(z.string().min(1).max(120)).max(32).default([]),
  reason: nonBlank.max(2_000),
  repeatOf: z.string().min(1).max(200).optional(),
}).strict();
export type DynamicPlannedAction = z.infer<typeof dynamicPlannedActionSchema>;

export const dynamicHumanDecisionRequestSchema = z.object({
  decisionKey: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/u),
  question: nonBlank.max(2_000),
  context: nonBlank.max(5_000).optional(),
  options: z.array(z.object({
    value: nonBlank.max(100),
    label: nonBlank.max(200),
    description: nonBlank.max(1_000).optional(),
  }).strict()).min(2).max(4),
  allowCustomAnswer: z.boolean(),
  allowAgentDecide: z.boolean(),
}).strict();
export type DynamicHumanDecisionRequest = z.infer<typeof dynamicHumanDecisionRequestSchema>;

export const dynamicCompletionCheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('continue'), reason: nonBlank.max(5_000) }).strict(),
  z.object({
    type: z.literal('completed'),
    reason: nonBlank.max(5_000),
    evidenceRefs: z.array(nonBlank.max(500)).max(100).default([]),
  }).strict(),
  z.object({
    type: z.literal('human_input_required'),
    reason: nonBlank.max(5_000),
    decision: dynamicHumanDecisionRequestSchema,
  }).strict(),
  z.object({
    type: z.literal('blocked'),
    reason: nonBlank.max(5_000),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/u),
  }).strict(),
]);
export type DynamicCompletionCheck = z.infer<typeof dynamicCompletionCheckSchema>;

export const dynamicExecutionPlanSchema = z.object({
  protocolVersion: dynamicExecutionProtocolVersionSchema,
  goalAssessment: nonBlank.max(10_000),
  contextVersion: z.number().int().nonnegative(),
  acknowledgedDecisionIds: z.array(nonBlank.max(500)).max(200).default([]),
  actions: z.array(dynamicPlannedActionSchema).max(32),
  completionCheck: dynamicCompletionCheckSchema,
}).strict();
export type DynamicExecutionPlan = z.infer<typeof dynamicExecutionPlanSchema>;

export const dynamicExecutionLimitsSchema = z.object({
  maxActionsPerPlan: z.number().int().positive().max(32),
  maxTotalActions: z.number().int().positive().max(1_000),
  maxConcurrentReadActions: z.number().int().positive().max(32),
  maxPlanningRounds: z.number().int().positive().max(100),
  maxPlanRepairAttempts: z.number().int().nonnegative().max(20),
  maxNoProgressRounds: z.number().int().positive().max(20),
  maxModelCalls: z.number().int().positive().max(1_000),
  maxTokens: z.number().int().positive().max(100_000_000),
  maxCost: z.number().nonnegative().max(100_000),
  maxWallClockMs: z.number().int().positive().max(604_800_000),
}).strict();
export type DynamicExecutionLimits = z.infer<typeof dynamicExecutionLimitsSchema>;

export const defaultDynamicExecutionLimits: DynamicExecutionLimits = Object.freeze({
  maxActionsPerPlan: 4,
  maxTotalActions: 16,
  maxConcurrentReadActions: 4,
  maxPlanningRounds: 8,
  maxPlanRepairAttempts: 2,
  maxNoProgressRounds: 2,
  maxModelCalls: 20,
  maxTokens: 120_000,
  maxCost: 10,
  maxWallClockMs: 7_200_000,
});

export const dynamicExecutionUsageSchema = z.object({
  planningRounds: z.number().int().nonnegative(),
  planRepairAttempts: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
}).strict();
export type DynamicExecutionUsage = z.infer<typeof dynamicExecutionUsageSchema>;

export const emptyDynamicExecutionUsage: DynamicExecutionUsage = Object.freeze({
  planningRounds: 0,
  planRepairAttempts: 0,
  actions: 0,
  modelCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cost: 0,
});

export const dynamicActionObservationSchema = z.object({
  executionId: nonBlank.max(500),
  round: z.number().int().positive(),
  actionId: nonBlank.max(120),
  activity: activityName,
  activityVersion: capabilityVersion,
  operationKey: nonBlank.max(1_000),
  fingerprint: nonBlank.max(5_000),
  status: z.enum(['succeeded', 'failed', 'skipped']),
  summary: nonBlank.max(5_000),
  result: dynamicJsonObjectSchema.optional(),
  error: z.object({
    code: nonBlank.max(200),
    message: nonBlank.max(5_000),
    retryable: z.boolean(),
  }).strict().optional(),
  resultBytes: z.number().int().nonnegative(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();
export type DynamicActionObservation = z.infer<typeof dynamicActionObservationSchema>;

export const dynamicExecutionTerminalStatusSchema = z.enum([
  'completed',
  'waiting_for_human',
  'blocked',
  'budget_exhausted',
]);
export type DynamicExecutionTerminalStatus = z.infer<typeof dynamicExecutionTerminalStatusSchema>;

export const dynamicExecutionModelInvocationSchema = z.object({
  provider: z.enum(['ollama', 'openrouter']).optional(),
  model: nonBlank.max(500),
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
  requestId: nonBlank.max(1_000).optional(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();
export type DynamicExecutionModelInvocation = z.infer<typeof dynamicExecutionModelInvocationSchema>;

export const dynamicCompletionVerificationSchema = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({
    name: nonBlank.max(200),
    passed: z.boolean(),
    evidenceRefs: z.array(nonBlank.max(500)).max(100).default([]),
    reason: nonBlank.max(2_000),
  }).strict()).min(1).max(100),
}).strict();
export type DynamicCompletionVerification = z.infer<typeof dynamicCompletionVerificationSchema>;

export const dynamicExecutionFindingCategorySchema = z.enum([
  'role_fidelity',
  'completeness',
  'consistency',
  'traceability',
  'fact_assumption',
  'blocking_condition',
  'artifact_contract',
  'quality',
]);
export type DynamicExecutionFindingCategory = z.infer<typeof dynamicExecutionFindingCategorySchema>;

export const dynamicExecutionFindingSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export const dynamicExecutionFindingDispositionSchema = z.enum([
  'block_iteration',
  'remediate_current',
  'defer_to_next_iteration',
  'accepted_risk',
  'not_applicable',
]);

const dynamicExecutionFindingBaseSchema = z.object({
  findingId: nonBlank.max(500),
  candidateVersion: z.number().int().positive(),
  category: dynamicExecutionFindingCategorySchema,
  severity: dynamicExecutionFindingSeveritySchema,
  ownerRole: z.enum(organismAgentRoles),
  disposition: dynamicExecutionFindingDispositionSchema,
  summary: nonBlank.max(2_000),
  evidenceRefs: z.array(nonBlank.max(1_000)).min(1).max(100),
  raisedByActionId: nonBlank.max(120),
}).strict();

export const dynamicExecutionFindingSchema = z.discriminatedUnion('status', [
  dynamicExecutionFindingBaseSchema.extend({
    status: z.literal('open'),
  }).strict(),
  dynamicExecutionFindingBaseSchema.extend({
    status: z.literal('resolved'),
    resolvedByActionId: nonBlank.max(120),
    resolvedInCandidateVersion: z.number().int().positive(),
  }).strict(),
]);
export type DynamicExecutionFinding = z.infer<typeof dynamicExecutionFindingSchema>;

export const dynamicExecutionTraceSchema = z.object({
  protocolVersion: dynamicExecutionProtocolVersionSchema,
  executionId: nonBlank.max(500),
  status: dynamicExecutionTerminalStatusSchema,
  terminalReason: nonBlank.max(5_000),
  limits: dynamicExecutionLimitsSchema,
  usage: dynamicExecutionUsageSchema,
  plans: z.array(z.object({
    round: z.number().int().positive(),
    repairAttempt: z.number().int().nonnegative(),
    accepted: z.boolean(),
    goalAssessment: z.string().max(10_000),
    actions: z.array(z.object({
      id: nonBlank.max(120),
      activity: activityName,
      activityVersion: capabilityVersion,
      dependsOn: z.array(nonBlank.max(120)),
      reason: nonBlank.max(2_000),
    }).strict()).max(32),
    completionType: z.enum(['continue', 'completed', 'human_input_required', 'blocked']),
    validationIssues: z.array(nonBlank.max(2_000)).max(100),
  }).strict()).max(2_100),
  observations: z.array(dynamicActionObservationSchema).max(1_100),
  invocations: z.array(dynamicExecutionModelInvocationSchema).max(1_000).default([]),
  findings: z.array(dynamicExecutionFindingSchema).max(100).default([]),
  verification: dynamicCompletionVerificationSchema.optional(),
  pendingDecision: dynamicHumanDecisionRequestSchema.optional(),
}).strict();
export type DynamicExecutionTrace = z.infer<typeof dynamicExecutionTraceSchema>;

export interface RegisteredDynamicCapability {
  descriptor: DynamicCapabilityDescriptor;
  validateArguments?: (arguments_: Record<string, unknown>) => readonly string[];
  validateResult?: (result: unknown) => readonly string[];
}

export interface PriorDynamicAction {
  actionId: string;
  fingerprint: string;
  status: 'succeeded' | 'failed' | 'skipped';
}

export interface DynamicPlanValidationContext {
  limits: DynamicExecutionLimits;
  totalActionsExecuted: number;
  authorityActions: ReadonlySet<string>;
  approvedActionIds?: ReadonlySet<string>;
  mutationScopes?: readonly string[];
  previousActions?: readonly PriorDynamicAction[];
  requiredDecisionIds?: readonly string[];
  requiredEvidenceRefs?: readonly string[];
  contextVersion?: number;
  /** Optional state-aware signature for capabilities whose empty arguments read durable workflow state. */
  actionFingerprint?: (action: DynamicPlannedAction) => string;
}

export type DynamicPlanValidationIssueCode =
  | 'INVALID_PLAN'
  | 'INVALID_CAPABILITY_REGISTRY'
  | 'ACTION_LIMIT_EXCEEDED'
  | 'UNKNOWN_ACTIVITY'
  | 'ACTIVITY_VERSION_MISMATCH'
  | 'INVALID_ARGUMENTS'
  | 'UNAUTHORIZED_ACTION'
  | 'APPROVAL_REQUIRED'
  | 'UNSAFE_PATH'
  | 'MUTATION_OUT_OF_SCOPE'
  | 'DUPLICATE_ACTION_ID'
  | 'DUPLICATE_DEPENDENCY'
  | 'UNKNOWN_DEPENDENCY'
  | 'FORWARD_DEPENDENCY'
  | 'DEPENDENCY_CYCLE'
  | 'REPEATED_ACTION'
  | 'STALE_CONTEXT'
  | 'HUMAN_DECISION_IGNORED'
  | 'MISSING_COMPLETION_EVIDENCE';

export interface DynamicPlanValidationIssue {
  code: DynamicPlanValidationIssueCode;
  message: string;
  actionId?: string;
}

export type DynamicPlanValidationResult = {
  ok: true;
  plan: DynamicExecutionPlan;
} | {
  ok: false;
  issues: DynamicPlanValidationIssue[];
};

function issue(
  code: DynamicPlanValidationIssueCode,
  message: string,
  actionId?: string,
): DynamicPlanValidationIssue {
  return { code, message, ...(actionId ? { actionId } : {}) };
}

export function canonicalDynamicJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDynamicJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalDynamicJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function dynamicActionFingerprint(
  action: Pick<DynamicPlannedAction, 'activity' | 'activityVersion' | 'arguments'>,
): string {
  return `${action.activity}@${action.activityVersion}:${canonicalDynamicJson(action.arguments)}`;
}

export function dynamicActionOperationKey(
  executionId: string,
  round: number,
  action: Pick<DynamicPlannedAction, 'id' | 'activity' | 'activityVersion'>,
): string {
  return `${executionId}/round/${round}/action/${action.id}/${action.activity}@${action.activityVersion}`;
}

export function isSafeDynamicRepositoryPath(value: string): boolean {
  if (!value || value !== value.trim() || value.startsWith('/') || value.includes('\\')) return false;
  if (/^[a-zA-Z]:/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  const lower = value.toLowerCase();
  if (lower === '.git' || lower.startsWith('.git/')) return false;
  if (lower === '.github/workflows' || lower.startsWith('.github/workflows/')) return false;
  if (lower === '.forgejo/workflows' || lower.startsWith('.forgejo/workflows/')) return false;
  return true;
}

function pathWithinScopes(path: string, scopes: readonly string[]): boolean {
  if (scopes.includes('*')) return true;
  return scopes.some((scope) => {
    const normalized = scope.replace(/\/+$/u, '');
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

export function validateDynamicCapabilityRegistry(
  registry: readonly RegisteredDynamicCapability[],
): DynamicPlanValidationIssue[] {
  const issues: DynamicPlanValidationIssue[] = [];
  const identities = new Set<string>();
  for (const entry of registry) {
    const parsed = dynamicCapabilityDescriptorSchema.safeParse(entry.descriptor);
    if (!parsed.success) {
      issues.push(issue('INVALID_CAPABILITY_REGISTRY', parsed.error.issues
        .map((entryIssue) => `${entryIssue.path.join('.') || 'descriptor'}: ${entryIssue.message}`)
        .join('; ')));
      continue;
    }
    const identity = `${parsed.data.name}@${parsed.data.version}`;
    if (identities.has(identity)) {
      issues.push(issue('INVALID_CAPABILITY_REGISTRY', `Duplicate capability ${identity}.`));
    }
    identities.add(identity);
    if (parsed.data.effect === 'mutating' && parsed.data.idempotency.mode !== 'operation_key') {
      issues.push(issue(
        'INVALID_CAPABILITY_REGISTRY',
        `Mutating capability ${identity} must require a durable operation key.`,
      ));
    }
    if (typeof entry.validateArguments !== 'function') {
      issues.push(issue(
        'INVALID_CAPABILITY_REGISTRY',
        `Capability ${identity} must provide an executable strict input validator.`,
      ));
    }
    if (typeof entry.validateResult !== 'function') {
      issues.push(issue(
        'INVALID_CAPABILITY_REGISTRY',
        `Capability ${identity} must provide an executable strict output validator.`,
      ));
    }
  }
  return issues;
}

export function validateDynamicExecutionPlan(
  value: unknown,
  registry: readonly RegisteredDynamicCapability[],
  context: DynamicPlanValidationContext,
): DynamicPlanValidationResult {
  const registryIssues = validateDynamicCapabilityRegistry(registry);
  const parsed = dynamicExecutionPlanSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        ...registryIssues,
        ...parsed.error.issues.map((parseIssue) => issue(
          'INVALID_PLAN',
          `${parseIssue.path.join('.') || 'plan'}: ${parseIssue.message}`,
        )),
      ],
    };
  }
  const plan = parsed.data;
  const issues = [...registryIssues];
  if (plan.actions.length > context.limits.maxActionsPerPlan
    || context.totalActionsExecuted + plan.actions.length > context.limits.maxTotalActions) {
    issues.push(issue('ACTION_LIMIT_EXCEEDED', 'The plan exceeds the configured action budget.'));
  }
  if (context.contextVersion !== undefined && plan.contextVersion !== context.contextVersion) {
    issues.push(issue('STALE_CONTEXT', `Expected context version ${context.contextVersion}, received ${plan.contextVersion}.`));
  }
  const acknowledgements = new Set(plan.acknowledgedDecisionIds);
  for (const decisionId of context.requiredDecisionIds ?? []) {
    if (!acknowledgements.has(decisionId)) {
      issues.push(issue('HUMAN_DECISION_IGNORED', `Durable decision ${decisionId} was not acknowledged.`));
    }
  }

  const capabilityByIdentity = new Map<string, RegisteredDynamicCapability>(
    registry.map((entry) => [`${entry.descriptor.name}@${entry.descriptor.version}`, entry] as const),
  );
  const actionIndex = new Map<string, number>();
  const currentFingerprints = new Map<string, string>();
  const previousById = new Map((context.previousActions ?? []).map((action) => [action.actionId, action]));
  const previousSucceededByFingerprint = new Map(
    (context.previousActions ?? [])
      .filter((action) => action.status === 'succeeded')
      .map((action) => [action.fingerprint, action]),
  );

  for (const [index, action] of plan.actions.entries()) {
    if (actionIndex.has(action.id) || previousById.has(action.id)) {
      issues.push(issue('DUPLICATE_ACTION_ID', `Action id ${action.id} is duplicated within this run.`, action.id));
    } else {
      actionIndex.set(action.id, index);
    }
  }

  for (const [index, action] of plan.actions.entries()) {
    const identity = `${action.activity}@${action.activityVersion}`;
    const capability = capabilityByIdentity.get(identity);
    if (!capability) {
      const sameName = registry.find((entry) => entry.descriptor.name === action.activity);
      issues.push(issue(
        sameName ? 'ACTIVITY_VERSION_MISMATCH' : 'UNKNOWN_ACTIVITY',
        sameName
          ? `Activity ${action.activity} is pinned to ${sameName.descriptor.version}, not ${action.activityVersion}.`
          : `Activity ${identity} is not available.`,
        action.id,
      ));
    } else {
      if (!context.authorityActions.has(capability.descriptor.requiredAuthorityAction)
        && !context.authorityActions.has('*')) {
        issues.push(issue('UNAUTHORIZED_ACTION', `Activity ${identity} is outside the authority grant.`, action.id));
      }
      if (capability.descriptor.approval === 'required'
        && !context.approvedActionIds?.has(action.id)) {
        issues.push(issue('APPROVAL_REQUIRED', `Activity ${identity} requires human approval.`, action.id));
      }
      for (const field of capability.descriptor.pathArguments) {
        const valueAtPath = action.arguments[field];
        const paths = typeof valueAtPath === 'string'
          ? [valueAtPath]
          : Array.isArray(valueAtPath) && valueAtPath.every((entry) => typeof entry === 'string')
            ? valueAtPath as string[]
            : [];
        if (paths.length === 0 && valueAtPath !== undefined) {
          issues.push(issue('INVALID_ARGUMENTS', `${field} must be a path or path array.`, action.id));
        }
        for (const path of paths) {
          if (!isSafeDynamicRepositoryPath(path)) {
            issues.push(issue('UNSAFE_PATH', `${field} contains an unsafe repository path: ${path}.`, action.id));
          } else if (capability.descriptor.effect === 'mutating'
            && !pathWithinScopes(path, context.mutationScopes ?? [])) {
            issues.push(issue('MUTATION_OUT_OF_SCOPE', `${path} is outside the declared mutation scope.`, action.id));
          }
        }
      }
      for (const argumentIssue of capability.validateArguments?.(action.arguments) ?? []) {
        issues.push(issue('INVALID_ARGUMENTS', argumentIssue, action.id));
      }
    }

    const dependencies = new Set<string>();
    for (const dependency of action.dependsOn) {
      if (dependencies.has(dependency)) {
        issues.push(issue('DUPLICATE_DEPENDENCY', `Dependency ${dependency} is duplicated.`, action.id));
      }
      dependencies.add(dependency);
      const dependencyIndex = actionIndex.get(dependency);
      if (dependencyIndex === undefined) {
        issues.push(issue('UNKNOWN_DEPENDENCY', `Dependency ${dependency} does not exist in this plan.`, action.id));
      } else if (dependencyIndex >= index) {
        issues.push(issue('FORWARD_DEPENDENCY', `Dependency ${dependency} must appear before ${action.id}.`, action.id));
      }
    }

    const fingerprint = context.actionFingerprint?.(action) ?? dynamicActionFingerprint(action);
    const priorCurrent = currentFingerprints.get(fingerprint);
    const priorHistory = previousSucceededByFingerprint.get(fingerprint);
    const repeatTarget = action.repeatOf ? previousById.get(action.repeatOf) : undefined;
    if (priorCurrent || priorHistory) {
      const justified = repeatTarget
        && repeatTarget.fingerprint === fingerprint
        && action.reason.trim().length >= 20;
      if (!justified) {
        issues.push(issue(
          'REPEATED_ACTION',
          `Action repeats ${priorCurrent ?? priorHistory?.actionId ?? 'completed work'} without a valid repeatOf and bounded justification.`,
          action.id,
        ));
      }
    }
    currentFingerprints.set(fingerprint, action.id);
  }

  // Retain cycle detection even though forward dependencies are rejected; it
  // gives a stable, explicit diagnosis for mutually dependent model output.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.actions.map((action) => [action.id, action]));
  const visit = (actionId: string): boolean => {
    if (visiting.has(actionId)) return true;
    if (visited.has(actionId)) return false;
    visiting.add(actionId);
    for (const dependency of byId.get(actionId)?.dependsOn ?? []) {
      if (byId.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(actionId);
    visited.add(actionId);
    return false;
  };
  if (plan.actions.some((action) => visit(action.id))) {
    issues.push(issue('DEPENDENCY_CYCLE', 'The action dependency graph contains a cycle.'));
  }

  if (plan.completionCheck.type === 'completed') {
    const evidence = new Set(plan.completionCheck.evidenceRefs);
    for (const required of context.requiredEvidenceRefs ?? []) {
      if (!evidence.has(required)) {
        issues.push(issue('MISSING_COMPLETION_EVIDENCE', `Completion is missing required evidence ${required}.`));
      }
    }
  }
  return issues.length === 0 ? { ok: true, plan } : { ok: false, issues };
}

export interface DynamicActionSchedule {
  ready: DynamicPlannedAction[];
  blocked: DynamicPlannedAction[];
  complete: boolean;
}

export function scheduleDynamicActionWave(
  plan: DynamicExecutionPlan,
  registry: readonly RegisteredDynamicCapability[],
  settled: ReadonlyMap<string, 'succeeded' | 'failed' | 'skipped'>,
  maxConcurrentReadActions: number,
): DynamicActionSchedule {
  const capabilityByIdentity = new Map<string, RegisteredDynamicCapability>(
    registry.map((entry) => [`${entry.descriptor.name}@${entry.descriptor.version}`, entry] as const),
  );
  const pending = plan.actions.filter((action) => !settled.has(action.id));
  const blocked = pending.filter((action) => action.dependsOn.some((dependency) => {
    const status = settled.get(dependency);
    return status === 'failed' || status === 'skipped';
  }));
  const blockedIds = new Set(blocked.map((action) => action.id));
  const candidates = pending.filter((action) => !blockedIds.has(action.id)
    && action.dependsOn.every((dependency) => settled.get(dependency) === 'succeeded'));
  const reads = candidates.filter((action) =>
    capabilityByIdentity.get(`${action.activity}@${action.activityVersion}`)?.descriptor.effect === 'read_only');
  const ready = reads.length > 0
    ? reads.slice(0, Math.max(1, maxConcurrentReadActions))
    : candidates.slice(0, 1);
  return {
    ready,
    blocked,
    complete: pending.length === 0,
  };
}

export function exhaustedDynamicExecutionLimits(
  usage: DynamicExecutionUsage,
  limits: DynamicExecutionLimits,
  elapsedMs: number,
): string[] {
  const exhausted: string[] = [];
  if (usage.planningRounds >= limits.maxPlanningRounds) exhausted.push('planning rounds');
  if (usage.actions >= limits.maxTotalActions) exhausted.push('actions');
  if (usage.modelCalls >= limits.maxModelCalls) exhausted.push('model calls');
  if (usage.totalTokens >= limits.maxTokens) exhausted.push('tokens');
  // Equality still permits a zero-cost local call. A hosted provider receives
  // the remaining $0 envelope and must reject before inference.
  if (usage.cost > limits.maxCost) exhausted.push('cost');
  if (elapsedMs >= limits.maxWallClockMs) exhausted.push('wall clock');
  return exhausted;
}
