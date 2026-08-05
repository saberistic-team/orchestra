import {
  canonicalDynamicJson,
  defaultDynamicExecutionLimits,
  dynamicActionFingerprint,
  dynamicActionOperationKey,
  dynamicExecutionPlanSchema,
  dynamicExecutionLimitsSchema,
  emptyDynamicExecutionUsage,
  exhaustedDynamicExecutionLimits,
  scheduleDynamicActionWave,
  validateDynamicExecutionPlan,
  type AgentArtifactDraft,
  type AgentExecutionInput,
  type DynamicActionObservation,
  type DynamicCapabilityDescriptor,
  type DynamicCompletionVerification,
  type DynamicExecutionLimits,
  type DynamicExecutionPlan,
  type DynamicExecutionFinding,
  type DynamicExecutionTrace,
  type DynamicExecutionUsage,
  type DynamicHumanDecisionRequest,
  type DynamicPlanValidationIssue,
  type RegisteredDynamicCapability,
} from '@orchestra/contracts';

export const DYNAMIC_AGENT_EXECUTION_PROTOCOL_VERSION = '1' as const;
export const MAX_DYNAMIC_ARTIFACT_REVISIONS = 2;

export interface DynamicModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DynamicInferenceBudget {
  maxTotalTokens: number;
  maxCost: number;
  deadlineEpochMs: number;
}

export interface DynamicModelReasoningRequest {
  role: AgentExecutionInput['role'];
  purpose: 'plan' | 'plan_repair' | 'progress_assessment' | 'completion_assessment';
  round: number;
  messages: DynamicModelMessage[];
  temperature: number;
  inferenceBudget?: DynamicInferenceBudget;
}

export interface DynamicModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export interface DynamicModelResult {
  provider?: 'ollama' | 'openrouter';
  model: string;
  content: string;
  requestId?: string;
  usage?: DynamicModelUsage;
}

export interface DynamicModelQualityReview {
  status: 'pass' | 'revise';
  rationale: string;
  findings: string[];
}

export interface DynamicModelCandidate extends DynamicModelResult {}

export type DynamicAgentModelActionRequest = {
  action: 'generate_candidate';
  input: AgentExecutionInput;
  inferenceBudget?: DynamicInferenceBudget;
} | {
  action: 'quality_review';
  input: AgentExecutionInput;
  candidate: string;
  round: number;
  inferenceBudget?: DynamicInferenceBudget;
} | {
  action: 'revise_candidate';
  input: AgentExecutionInput;
  candidate: string;
  review: DynamicModelQualityReview;
  round: number;
  inferenceBudget?: DynamicInferenceBudget;
} | {
  action: 'finalize_candidate';
  input: AgentExecutionInput;
  candidate: DynamicModelCandidate;
  modelInvocations: NonNullable<AgentArtifactDraft['modelInvocations']>;
};

type DynamicArtifactInvocation = NonNullable<AgentArtifactDraft['modelInvocations']>[number];

export type DynamicAgentModelActionResult = {
  action: 'generate_candidate' | 'revise_candidate';
  candidate: DynamicModelCandidate;
  invocation: DynamicArtifactInvocation;
} | {
  action: 'quality_review';
  inference: DynamicModelResult;
  review: DynamicModelQualityReview;
  invocation: DynamicArtifactInvocation;
} | {
  action: 'finalize_candidate';
  draft: AgentArtifactDraft;
};

export interface DynamicArtifactExecutionGateways {
  reason(
    request: DynamicModelReasoningRequest,
    operationKey: string,
  ): Promise<DynamicModelResult>;
  act(
    request: DynamicAgentModelActionRequest,
    operationKey: string,
  ): Promise<DynamicAgentModelActionResult>;
  now?(): number;
}

export interface DynamicArtifactExecutionInput {
  executionId: string;
  input: AgentExecutionInput;
  contextVersion: number;
  requiredDecisionIds?: string[];
  authorityActions?: string[];
  allowedActivities?: string[];
  mutationScopes?: string[];
  requiredEvidenceRefs?: string[];
  /** Workflow-owned evidence identities available before this order starts. */
  availableEvidenceRefs?: string[];
  limits?: Partial<DynamicExecutionLimits>;
  /** Temporal-patched rollout for provider-side hard ceilings. */
  enforceProviderBudgets?: boolean;
  /**
   * Temporal-patched rollout that treats human-input and blocked completions
   * as control-plane outcomes. Their structured decision/reason is complete,
   * so model-authored artifact actions are conservatively ignored.
   */
  discardTerminalControlActions?: boolean;
  /** Temporal-patched rollout that observes each mutating artifact action before planning the next one. */
  serializeArtifactActions?: boolean;
  /** Temporal-patched rollout that binds workflow-owned context metadata to the current request. */
  bindPlanningContextVersion?: boolean;
  /** Temporal-patched rollout that discards arguments for workflow-owned model actions. */
  discardModelAuthoredArguments?: boolean;
  /** Temporal-patched rollout that strips planner-only metadata from decision options. */
  normalizeDecisionOptions?: boolean;
  /** Temporal-patched rollout for mechanical aliases in the human-decision envelope. */
  normalizeDecisionEnvelope?: boolean;
  /** Temporal-patched rollout that binds artifact actions to the recorded candidate/review state. */
  normalizeArtifactStateTransitions?: boolean;
  /**
   * A human-decision resume carries new approved context that the checkpointed
   * candidate and its review could not have considered. Invalidate that stale
   * review so the workflow revises the retained candidate exactly once before
   * reviewing and finalizing it again.
   */
  refreshCandidateAfterHumanDecision?: boolean;
  /** Replay-safe rollout for accepting a reviewed candidate at the exhausted revision boundary. */
  honorHumanReviewWaiver?: boolean;
  /** Replay-safe rollout that moves waived candidate questions out of the active decision channel. */
  deferQuestionsAfterHumanReviewWaiver?: boolean;
  checkpoint?: DynamicArtifactExecutionCheckpoint;
}

/**
 * Serializable interpreter state captured only at a safe human-decision
 * boundary. Keeping it separate from the public trace lets a resumed order
 * retain its candidate and review state without exposing those potentially
 * large model payloads as UI/audit data.
 */
export interface DynamicArtifactExecutionCheckpoint {
  protocolVersion: typeof DYNAMIC_AGENT_EXECUTION_PROTOCOL_VERSION;
  executionId: string;
  limits: DynamicExecutionLimits;
  elapsedMs: number;
  candidate?: DynamicModelCandidate;
  candidateVersion: number;
  review?: DynamicModelQualityReview & { candidateVersion: number };
  revisionCount: number;
  usage: DynamicExecutionUsage;
  observations: DynamicActionObservation[];
  previousActions: Array<{
    actionId: string;
    fingerprint: string;
    status: 'succeeded' | 'failed' | 'skipped';
  }>;
  invocations: DynamicArtifactInvocation[];
  plans: DynamicExecutionTrace['plans'];
  findings: DynamicExecutionFinding[];
  noProgressRounds: number;
}

export type DynamicArtifactExecutionResult = {
  status: 'completed';
  draft: AgentArtifactDraft;
  trace: DynamicExecutionTrace;
} | {
  status: 'waiting_for_human';
  decision: DynamicHumanDecisionRequest;
  trace: DynamicExecutionTrace;
  checkpoint: DynamicArtifactExecutionCheckpoint;
} | {
  status: 'blocked' | 'budget_exhausted';
  reason: string;
  trace: DynamicExecutionTrace;
};

function descriptor(
  name: string,
  description: string,
): DynamicCapabilityDescriptor {
  return {
    protocolVersion: '1',
    name,
    version: '1.0',
    description,
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object' },
    requiredAuthorityAction: 'EXECUTE_BOUNDED_STEP',
    // These calls mutate the candidate/review state observed by the durable
    // interpreter, so they are intentionally serialized even though they do
    // not directly mutate the repository.
    effect: 'mutating',
    idempotency: { mode: 'operation_key', conflictPolicy: 'reuse_result' },
    timeoutMs: 1_800_000,
    retryPolicy: { maximumAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 1 },
    dataClassifications: ['project_context'],
    // Leave ample room beneath Temporal's 2 MiB payload ceiling for the
    // surrounding Activity/child-workflow envelope. Durable artifact handoffs
    // themselves use content-addressed references.
    maxResultBytes: 1_000_000,
    approval: 'never',
    pathArguments: [],
  };
}

export const dynamicArtifactCapabilities: readonly RegisteredDynamicCapability[] = Object.freeze([
  {
    descriptor: descriptor(
      'model.generate_artifact',
      'Create one complete candidate for the assigned role artifact.',
    ),
    validateArguments: validateEmptyArguments,
    validateResult: (result) => validateArtifactActionResult('generate_candidate', result),
  },
  {
    descriptor: descriptor(
      'model.review_artifact',
      'Independently assess the current candidate and return bounded findings.',
    ),
    validateArguments: validateEmptyArguments,
    validateResult: (result) => validateArtifactActionResult('quality_review', result),
  },
  {
    descriptor: descriptor(
      'model.revise_artifact',
      'Replace the current candidate while addressing its recorded review findings.',
    ),
    validateArguments: validateEmptyArguments,
    validateResult: (result) => validateArtifactActionResult('revise_candidate', result),
  },
]);

function validateEmptyArguments(arguments_: Record<string, unknown>): string[] {
  return Object.keys(arguments_).length === 0
    ? []
    : ['This activity accepts no model-authored arguments; its inputs come from recorded workflow state.'];
}

function isDynamicRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unexpectedDynamicKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): string[] {
  const allowedKeys = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !allowedKeys.has(key));
  return extras.length > 0 ? [`${label} contains unknown fields: ${extras.join(', ')}.`] : [];
}

function validateDynamicUsage(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!isDynamicRecord(value)) return [`${label} must be an object.`];
  const issues = unexpectedDynamicKeys(
    value,
    ['promptTokens', 'completionTokens', 'totalTokens', 'cost'],
    label,
  );
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cost'] as const) {
    const amount = value[key];
    if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) {
      issues.push(`${label}.${key} must be a finite non-negative number.`);
    }
  }
  return issues;
}

function validateDynamicInferenceResult(value: unknown, label: string): string[] {
  if (!isDynamicRecord(value)) return [`${label} must be an object.`];
  const issues = unexpectedDynamicKeys(
    value,
    ['provider', 'model', 'content', 'requestId', 'usage'],
    label,
  );
  if (value.provider !== undefined && value.provider !== 'ollama' && value.provider !== 'openrouter') {
    issues.push(`${label}.provider is invalid.`);
  }
  if (typeof value.model !== 'string' || !value.model.trim()) issues.push(`${label}.model is required.`);
  if (typeof value.content !== 'string' || !value.content.trim()) issues.push(`${label}.content is required.`);
  if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !value.requestId.trim())) {
    issues.push(`${label}.requestId must be a non-empty string.`);
  }
  issues.push(...validateDynamicUsage(value.usage, `${label}.usage`));
  return issues;
}

function validateDynamicInvocation(value: unknown): string[] {
  if (!isDynamicRecord(value)) return ['invocation must be an object.'];
  const issues = unexpectedDynamicKeys(
    value,
    ['provider', 'model', 'purpose', 'round', 'requestId', 'usage'],
    'invocation',
  );
  if (value.provider !== undefined && value.provider !== 'ollama' && value.provider !== 'openrouter') {
    issues.push('invocation.provider is invalid.');
  }
  if (typeof value.model !== 'string' || !value.model.trim()) issues.push('invocation.model is required.');
  if (!['generate', 'quality_review', 'revise'].includes(String(value.purpose))) {
    issues.push('invocation.purpose is invalid for an artifact action.');
  }
  if (!Number.isInteger(value.round) || (value.round as number) < 0) {
    issues.push('invocation.round must be a non-negative integer.');
  }
  if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !value.requestId.trim())) {
    issues.push('invocation.requestId must be a non-empty string.');
  }
  issues.push(...validateDynamicUsage(value.usage, 'invocation.usage'));
  return issues;
}

function validateArtifactActionResult(
  expectedAction: 'generate_candidate' | 'quality_review' | 'revise_candidate',
  value: unknown,
): string[] {
  if (!isDynamicRecord(value)) return ['Capability result must be an object.'];
  const qualityReview = expectedAction === 'quality_review';
  const issues = unexpectedDynamicKeys(
    value,
    qualityReview
      ? ['action', 'inference', 'review', 'invocation']
      : ['action', 'candidate', 'invocation'],
    'Capability result',
  );
  if (value.action !== expectedAction) issues.push(`Capability result action must be ${expectedAction}.`);
  issues.push(...validateDynamicInferenceResult(
    qualityReview ? value.inference : value.candidate,
    qualityReview ? 'inference' : 'candidate',
  ));
  issues.push(...validateDynamicInvocation(value.invocation));
  if (qualityReview) {
    if (!isDynamicRecord(value.review)) {
      issues.push('review must be an object.');
    } else {
      issues.push(...unexpectedDynamicKeys(value.review, ['status', 'rationale', 'findings'], 'review'));
      if (value.review.status !== 'pass' && value.review.status !== 'revise') {
        issues.push('review.status must be pass or revise.');
      }
      if (typeof value.review.rationale !== 'string' || !value.review.rationale.trim()) {
        issues.push('review.rationale is required.');
      }
      if (!Array.isArray(value.review.findings)
        || value.review.findings.some((finding) => typeof finding !== 'string')) {
        issues.push('review.findings must be a string array.');
      }
    }
  }
  return issues;
}

function capabilitiesForExecution(input: DynamicArtifactExecutionInput): readonly RegisteredDynamicCapability[] {
  if (!input.allowedActivities) return dynamicArtifactCapabilities;
  const allowed = new Set(input.allowedActivities);
  return dynamicArtifactCapabilities.filter(({ descriptor: capability }) => allowed.has(capability.name));
}

function summarizeCapabilities(input: DynamicArtifactExecutionInput) {
  return capabilitiesForExecution(input).map(({ descriptor: capability }) => ({
    activity: capability.name,
    activityVersion: capability.version,
    description: capability.description,
    effect: capability.effect,
  }));
}

interface ArtifactLoopState {
  candidate?: DynamicModelCandidate;
  candidateVersion: number;
  review?: DynamicModelQualityReview & { candidateVersion: number };
  revisionCount: number;
  usage: DynamicExecutionUsage;
  observations: DynamicActionObservation[];
  previousActions: Array<{
    actionId: string;
    fingerprint: string;
    status: 'succeeded' | 'failed' | 'skipped';
  }>;
  invocations: DynamicArtifactInvocation[];
  plans: DynamicExecutionTrace['plans'];
  findings: DynamicExecutionFinding[];
  noProgressRounds: number;
}

function copyCheckpointValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function checkpointState(
  executionId: string,
  limits: DynamicExecutionLimits,
  state: ArtifactLoopState,
  elapsedMs: number,
): DynamicArtifactExecutionCheckpoint {
  return copyCheckpointValue({
    protocolVersion: DYNAMIC_AGENT_EXECUTION_PROTOCOL_VERSION,
    executionId,
    limits,
    elapsedMs,
    candidate: state.candidate,
    candidateVersion: state.candidateVersion,
    review: state.review,
    revisionCount: state.revisionCount,
    usage: state.usage,
    observations: state.observations,
    previousActions: state.previousActions,
    invocations: state.invocations,
    plans: state.plans,
    findings: state.findings,
    noProgressRounds: state.noProgressRounds,
  });
}

function stateFromCheckpoint(checkpoint: DynamicArtifactExecutionCheckpoint): ArtifactLoopState {
  const restored = copyCheckpointValue(checkpoint);
  return {
    candidate: restored.candidate,
    candidateVersion: restored.candidateVersion,
    review: restored.review,
    revisionCount: restored.revisionCount,
    usage: restored.usage,
    observations: restored.observations,
    previousActions: restored.previousActions,
    invocations: restored.invocations,
    plans: restored.plans,
    findings: restored.findings ?? [],
    noProgressRounds: restored.noProgressRounds,
  };
}

function plannerState(state: ArtifactLoopState) {
  return {
    candidate: state.candidate ? {
      version: state.candidateVersion,
      model: state.candidate.model,
      requestId: state.candidate.requestId,
    } : null,
    review: state.review ?? null,
    revisionsUsed: state.revisionCount,
    maximumRevisions: MAX_DYNAMIC_ARTIFACT_REVISIONS,
    latestObservations: state.observations.slice(-8).map((observation) => ({
      actionId: observation.actionId,
      activity: observation.activity,
      status: observation.status,
      summary: observation.summary,
      error: observation.error,
    })),
    openFindings: state.findings.filter((finding) => finding.status === 'open').slice(-20),
    usage: state.usage,
  };
}

function plannerSystemPrompt(input: DynamicArtifactExecutionInput) {
  return [
    `You are planning the next bounded action batch for the ${input.input.role} agent.`,
    'You propose commands; the deterministic workflow validates and executes them.',
    'Return only one strict JSON object. Never return Markdown fences or commentary.',
    'Use exactly this shape:',
    '{"protocolVersion":"1","goalAssessment":"...","contextVersion":0,"acknowledgedDecisionIds":[],"actions":[{"id":"...","activity":"...","activityVersion":"1.0","arguments":{},"dependsOn":[],"reason":"..."}],"completionCheck":{"type":"continue","reason":"..."}}',
    'completionCheck.type is continue, completed, human_input_required, or blocked.',
    'For completed include evidenceRefs. For human_input_required include one decision with a stable decisionKey, 2-4 options, allowCustomAnswer, and allowAgentDecide. For blocked include an uppercase code.',
    ...(input.discardTerminalControlActions ? [
      'For human_input_required or blocked, actions must be []. The structured decision or blocker is the complete terminal output; never generate an artifact to explain it.',
    ] : []),
    ...(input.serializeArtifactActions ? [
      'Plan at most one artifact action per batch. Observe generation, review, or revision before planning the next artifact action.',
    ] : []),
    ...(input.discardModelAuthoredArguments ? [
      'All model artifact activity arguments must be {}. Candidate, review, role, and project inputs are supplied from recorded workflow state, never from the plan.',
    ] : []),
    ...(input.normalizeDecisionOptions ? [
      'Each human decision option must contain only value, label, and optional description. Do not add key, id, or other fields.',
    ] : []),
    ...(input.normalizeDecisionEnvelope ? [
      'A human decision must use question (never prompt) and a lowercase decisionKey separated with dots, underscores, or hyphens (never colons).',
    ] : []),
    ...(input.normalizeArtifactStateTransitions ? [
      'Artifact progression is workflow-owned: generate when no candidate exists, review the current candidate once, revise only after recorded findings, and complete after a passing current review.',
    ] : []),
    'Plan only the next useful batch. Incorporate observations before choosing later work.',
    'Do not repeat a successful action. Do not claim completed unless the current candidate has a passing review; the workflow will still verify the artifact contract.',
    `The exact capability catalog is ${JSON.stringify(summarizeCapabilities(input))}.`,
    `The required contextVersion is ${input.contextVersion}.`,
    `Acknowledge all durable decision IDs: ${JSON.stringify(input.requiredDecisionIds ?? [])}.`,
    `Completion must cite these evidence refs: ${JSON.stringify(input.requiredEvidenceRefs ?? [])}.`,
  ].join(' ');
}

function discardTerminalControlActions(
  plan: DynamicExecutionPlan,
  enabled: boolean | undefined,
): DynamicExecutionPlan {
  if (!enabled || plan.actions.length === 0) return plan;
  if (plan.completionCheck.type !== 'human_input_required'
    && plan.completionCheck.type !== 'blocked') return plan;
  return { ...plan, actions: [] };
}

function serializeArtifactActions(
  plan: DynamicExecutionPlan,
  enabled: boolean | undefined,
): DynamicExecutionPlan {
  if (!enabled || plan.actions.length <= 1) return plan;
  return {
    ...plan,
    actions: plan.actions.slice(0, 1),
    completionCheck: {
      type: 'continue',
      reason: 'Observe the first bounded artifact action before planning the next one.',
    },
  };
}

function bindPlanningContextVersion(
  plan: DynamicExecutionPlan,
  contextVersion: number,
  enabled: boolean | undefined,
): DynamicExecutionPlan {
  return enabled && plan.contextVersion !== contextVersion
    ? { ...plan, contextVersion }
    : plan;
}

function discardModelAuthoredArguments(
  plan: DynamicExecutionPlan,
  enabled: boolean | undefined,
): DynamicExecutionPlan {
  if (!enabled || plan.actions.every((action) => Object.keys(action.arguments).length === 0)) return plan;
  return {
    ...plan,
    actions: plan.actions.map((action) => ({ ...action, arguments: {} })),
  };
}

function normalizeDecisionOptions(value: unknown, enabled: boolean | undefined): unknown {
  if (!enabled || !isDynamicRecord(value)) return value;
  const completionCheck = value.completionCheck;
  if (!isDynamicRecord(completionCheck) || completionCheck.type !== 'human_input_required') return value;
  const decision = completionCheck.decision;
  if (!isDynamicRecord(decision) || !Array.isArray(decision.options)) return value;
  return {
    ...value,
    completionCheck: {
      ...completionCheck,
      decision: {
        ...decision,
        options: decision.options.map((option) => {
          if (!isDynamicRecord(option)) return option;
          return {
            ...(option.value !== undefined ? { value: option.value } : {}),
            ...(option.label !== undefined ? { label: option.label } : {}),
            ...(option.description !== undefined ? { description: option.description } : {}),
          };
        }),
      },
    },
  };
}

function normalizedDecisionKey(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '.')
    .replace(/^[._-]+|[._-]+$/gu, '');
}

function normalizeDecisionEnvelope(value: unknown, enabled: boolean | undefined): unknown {
  if (!enabled || !isDynamicRecord(value)) return value;
  const completionCheck = value.completionCheck;
  if (!isDynamicRecord(completionCheck) || completionCheck.type !== 'human_input_required') return value;
  const decision = completionCheck.decision;
  if (!isDynamicRecord(decision)) return value;
  return {
    ...value,
    completionCheck: {
      ...completionCheck,
      decision: {
        ...(decision.decisionKey !== undefined
          ? { decisionKey: normalizedDecisionKey(decision.decisionKey) }
          : {}),
        ...(decision.question !== undefined
          ? { question: decision.question }
          : decision.prompt !== undefined ? { question: decision.prompt } : {}),
        ...(decision.context !== undefined ? { context: decision.context } : {}),
        ...(decision.options !== undefined ? { options: decision.options } : {}),
        ...(decision.allowCustomAnswer !== undefined
          ? { allowCustomAnswer: decision.allowCustomAnswer }
          : {}),
        ...(decision.allowAgentDecide !== undefined
          ? { allowAgentDecide: decision.allowAgentDecide }
          : {}),
      },
    },
  };
}

function normalizeArtifactStateTransitions(
  plan: DynamicExecutionPlan,
  state: ArtifactLoopState,
  input: DynamicArtifactExecutionInput,
  round: number,
  enabled: boolean | undefined,
): DynamicExecutionPlan {
  if (!enabled || plan.completionCheck.type === 'human_input_required'
    || plan.completionCheck.type === 'blocked') return plan;
  const currentReview = state.review?.candidateVersion === state.candidateVersion
    ? state.review
    : undefined;
  if (humanDecisionAcceptsCandidateAtRevisionLimit(plan, state, input)) {
    return plan.actions.length === 0 ? plan : {
      ...plan,
      actions: [],
      completionCheck: {
        type: 'completed',
        reason: 'The recorded human decision accepts the current candidate with documented deviations; the requested non-mutating re-review is waived at the exhausted revision boundary.',
        evidenceRefs: [...(input.requiredEvidenceRefs ?? [])],
      },
    };
  }
  if (state.candidate && currentReview?.status === 'pass') {
    return {
      ...plan,
      actions: [],
      completionCheck: {
        type: 'completed',
        reason: 'The recorded current candidate passed independent review.',
        evidenceRefs: [...(input.requiredEvidenceRefs ?? [])],
      },
    };
  }
  const requiredActivity = !state.candidate
    ? 'model.generate_artifact'
    : currentReview?.status === 'revise'
      ? 'model.revise_artifact'
      : 'model.review_artifact';
  const first = plan.actions[0] ?? {
    id: `workflow-state-${round}-${state.candidateVersion}-${state.usage.actions + 1}`,
    activity: requiredActivity,
    activityVersion: '1.0',
    arguments: {},
    dependsOn: [],
    reason: `Advance the recorded artifact state through ${requiredActivity}.`,
  };
  if (plan.actions.length > 0
    && first.activity === requiredActivity
    && first.dependsOn.length === 0
    && first.repeatOf === undefined) return plan;
  return {
    ...plan,
    actions: [{
      ...first,
      activity: requiredActivity,
      activityVersion: '1.0',
      arguments: {},
      dependsOn: [],
      repeatOf: undefined,
      reason: `Advance the recorded artifact state through ${requiredActivity}.`,
    }],
    completionCheck: {
      type: 'continue',
      reason: 'Observe the workflow-owned artifact state transition before planning again.',
    },
  };
}

function humanDecisionAcceptsCandidateAtRevisionLimit(
  plan: DynamicExecutionPlan,
  state: ArtifactLoopState,
  input: DynamicArtifactExecutionInput,
): boolean {
  const currentReview = state.review?.candidateVersion === state.candidateVersion
    ? state.review
    : undefined;
  return Boolean(
    input.refreshCandidateAfterHumanDecision
    && input.honorHumanReviewWaiver
    && state.candidate
    && currentReview?.status === 'revise'
    && state.revisionCount >= MAX_DYNAMIC_ARTIFACT_REVISIONS
    && ((plan.actions.length === 0 && plan.completionCheck.type === 'completed')
      || (plan.actions.length === 1 && plan.actions[0]?.activity === 'model.review_artifact')),
  );
}

function recordHumanDecisionReviewWaiver(
  state: ArtifactLoopState,
  input: DynamicArtifactExecutionInput,
): void {
  const evidenceRefs = input.requiredDecisionIds ?? [];
  state.review = {
    status: 'pass',
    rationale: 'The recorded human decision accepted the current candidate with documented deviations after the bounded revision limit was exhausted.',
    findings: [],
    candidateVersion: state.candidateVersion,
  };
  state.findings = state.findings.map((finding): DynamicExecutionFinding => {
    if (finding.status !== 'open' || finding.candidateVersion !== state.candidateVersion) return finding;
    return {
      ...finding,
      status: 'resolved',
      disposition: 'defer_to_next_iteration',
      evidenceRefs: [...new Set([...finding.evidenceRefs, ...evidenceRefs])],
      resolvedByActionId: 'human-decision-review-waiver',
      resolvedInCandidateVersion: state.candidateVersion,
    };
  });
  state.noProgressRounds = 0;
}

function plannerUserPrompt(input: DynamicArtifactExecutionInput, state: ArtifactLoopState) {
  return [
    `Goal: produce ${input.input.artifactType} for iteration ${input.input.iteration.number}.`,
    `Objective: ${input.input.iteration.objective}`,
    `Project: ${input.input.project.name}`,
    `Current state: ${JSON.stringify(plannerState(state))}`,
    '<APPROVED_CONTEXT>',
    input.input.context.slice(0, 24_000),
    '</APPROVED_CONTEXT>',
  ].join('\n');
}

export function buildDynamicPlanningRequest(
  input: DynamicArtifactExecutionInput,
  state: Pick<ArtifactLoopState, 'candidate' | 'candidateVersion' | 'review' | 'revisionCount' | 'usage' | 'observations'>,
  round: number,
): DynamicModelReasoningRequest {
  const completeState: ArtifactLoopState = {
    ...state,
    previousActions: [],
    invocations: [],
    plans: [],
    findings: [],
    noProgressRounds: 0,
  };
  return {
    role: input.input.role,
    purpose: 'plan',
    round,
    temperature: 0,
    messages: [
      { role: 'system', content: plannerSystemPrompt(input) },
      { role: 'user', content: plannerUserPrompt(input, completeState) },
    ],
  };
}

export function buildDynamicPlanRepairRequest(
  input: DynamicArtifactExecutionInput,
  state: ArtifactLoopState,
  round: number,
  repairAttempt: number,
  invalidOutput: string,
  issues: readonly DynamicPlanValidationIssue[],
): DynamicModelReasoningRequest {
  return {
    role: input.input.role,
    purpose: 'plan_repair',
    round,
    temperature: 0,
    messages: [
      { role: 'system', content: plannerSystemPrompt(input) },
      {
        role: 'user',
        content: [
          plannerUserPrompt(input, state),
          `<INVALID_PLAN attempt="${repairAttempt}">`,
          invalidOutput.slice(0, 30_000),
          '</INVALID_PLAN>',
          '<VALIDATION_ISSUES>',
          ...issues.map((entry) => `- ${entry.code}: ${entry.message}`),
          '</VALIDATION_ISSUES>',
          'Return a complete replacement plan. No action from the invalid plan ran.',
        ].join('\n'),
      },
    ],
  };
}

export function parseDynamicExecutionPlan(raw: string): unknown {
  return JSON.parse(raw.trim()) as unknown;
}

function addModelUsage(usage: DynamicExecutionUsage, result: DynamicModelResult): DynamicExecutionUsage {
  const reportedUsage = result.usage;
  if (!reportedUsage) {
    throw new ModelUsageAccountingError(
      'MODEL_USAGE_UNAVAILABLE',
      'Model did not report usage; token and cost budgets cannot be enforced.',
    );
  }
  if (reportedUsage.totalTokens === undefined
    && (reportedUsage.promptTokens === undefined || reportedUsage.completionTokens === undefined)) {
    throw new ModelUsageAccountingError(
      'MODEL_USAGE_UNAVAILABLE',
      'Model did not report total token usage or both token components.',
    );
  }
  if (result.provider !== 'ollama' && reportedUsage.cost === undefined) {
    throw new ModelUsageAccountingError(
      'MODEL_USAGE_UNAVAILABLE',
      'Non-local model did not report cost usage.',
    );
  }
  const tokenCount = (value: number | undefined, name: string) => {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ModelUsageAccountingError('MODEL_USAGE_INVALID', `Model reported invalid ${name}.`);
    }
    return value;
  };
  const promptTokens = tokenCount(reportedUsage.promptTokens, 'prompt token usage');
  const completionTokens = tokenCount(reportedUsage.completionTokens, 'completion token usage');
  const reportedTotal = tokenCount(reportedUsage.totalTokens, 'total token usage');
  const cost = reportedUsage.cost ?? 0;
  if (!Number.isFinite(cost) || cost < 0) {
    throw new ModelUsageAccountingError('MODEL_USAGE_INVALID', 'Model reported invalid cost usage.');
  }
  return {
    ...usage,
    promptTokens: usage.promptTokens + promptTokens,
    completionTokens: usage.completionTokens + completionTokens,
    totalTokens: usage.totalTokens + Math.max(reportedTotal, promptTokens + completionTokens),
    cost: usage.cost + cost,
  };
}

class ModelUsageAccountingError extends Error {
  constructor(
    readonly code: 'MODEL_USAGE_UNAVAILABLE' | 'MODEL_USAGE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ModelUsageAccountingError';
  }
}

function recordModelAttempt(usage: DynamicExecutionUsage): DynamicExecutionUsage {
  return { ...usage, modelCalls: usage.modelCalls + 1 };
}

function auditableInvocation(invocation: DynamicArtifactInvocation): DynamicArtifactInvocation {
  const usage = invocation.usage;
  const validTokenValue = (value: number | undefined) =>
    value === undefined || (Number.isSafeInteger(value) && value >= 0);
  const validCost = usage?.cost === undefined || (Number.isFinite(usage.cost) && usage.cost >= 0);
  const validUsage = usage
    && validTokenValue(usage.promptTokens)
    && validTokenValue(usage.completionTokens)
    && validTokenValue(usage.totalTokens)
    && validCost
    ? usage
    : undefined;
  return { ...invocation, usage: validUsage };
}

function planningInvocation(
  result: DynamicModelResult,
  purpose: 'plan' | 'plan_repair',
  round: number,
): DynamicArtifactInvocation {
  return auditableInvocation({
    provider: result.provider,
    model: result.model,
    purpose,
    round,
    requestId: result.requestId,
    usage: result.usage,
  });
}

function parseIssues(error: unknown): DynamicPlanValidationIssue[] {
  return [{
    code: 'INVALID_PLAN',
    message: error instanceof Error ? error.message : 'The model returned malformed plan JSON.',
  }];
}

function tracePlan(
  round: number,
  repairAttempt: number,
  value: unknown,
  accepted: boolean,
  issues: readonly DynamicPlanValidationIssue[],
): DynamicExecutionTrace['plans'][number] {
  const parsed = dynamicExecutionPlanSchema.safeParse(value);
  return {
    round,
    repairAttempt,
    accepted,
    goalAssessment: parsed.success ? parsed.data.goalAssessment : '',
    actions: parsed.success ? parsed.data.actions.map((action) => ({
      id: action.id,
      activity: action.activity,
      activityVersion: action.activityVersion,
      dependsOn: action.dependsOn,
      reason: action.reason,
    })) : [],
    completionType: parsed.success ? parsed.data.completionCheck.type : 'continue',
    validationIssues: issues.map((entry) => `${entry.code}: ${entry.message}`),
  };
}

function parseLimits(overrides?: Partial<DynamicExecutionLimits>) {
  return dynamicExecutionLimitsSchema.safeParse({ ...defaultDynamicExecutionLimits, ...overrides });
}

function resultBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedActionResultBytes(
  action: DynamicExecutionPlan['actions'][number],
  value: unknown,
): number {
  const capability = dynamicArtifactCapabilities.find(({ descriptor: candidate }) =>
    candidate.name === action.activity && candidate.version === action.activityVersion);
  if (!capability) throw new Error(`No capability descriptor is registered for ${action.activity}@${action.activityVersion}.`);
  const bytes = resultBytes(value);
  if (bytes > capability.descriptor.maxResultBytes) {
    throw new Error(
      `${action.activity} returned ${bytes} bytes, exceeding its ${capability.descriptor.maxResultBytes}-byte result limit.`,
    );
  }
  return bytes;
}

function assertValidActionResult(
  action: DynamicExecutionPlan['actions'][number],
  value: unknown,
): void {
  const capability = dynamicArtifactCapabilities.find(({ descriptor: candidate }) =>
    candidate.name === action.activity && candidate.version === action.activityVersion);
  if (!capability?.validateResult) {
    throw new Error(`No output validator is registered for ${action.activity}@${action.activityVersion}.`);
  }
  const issues = capability.validateResult(value);
  if (issues.length > 0) {
    throw new Error(`${action.activity} returned an invalid result: ${issues.join(' ')}`);
  }
}

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 5_000);
}

function trace(
  executionId: string,
  status: DynamicExecutionTrace['status'],
  terminalReason: string,
  limits: DynamicExecutionLimits,
  state: ArtifactLoopState,
  verification?: DynamicCompletionVerification,
  pendingDecision?: DynamicHumanDecisionRequest,
): DynamicExecutionTrace {
  return {
    protocolVersion: '1',
    executionId,
    status,
    terminalReason,
    limits,
    usage: state.usage,
    plans: state.plans,
    observations: state.observations,
    invocations: state.invocations,
    findings: state.findings,
    ...(verification ? { verification } : {}),
    ...(pendingDecision ? { pendingDecision } : {}),
  };
}

function semanticArtifactPlanIssues(
  plan: DynamicExecutionPlan,
  state: ArtifactLoopState,
  limits: DynamicExecutionLimits,
): DynamicPlanValidationIssue[] {
  const issues: DynamicPlanValidationIssue[] = [];
  if (state.usage.modelCalls + plan.actions.length > limits.maxModelCalls) {
    issues.push({
      code: 'ACTION_LIMIT_EXCEEDED',
      message: 'The plan would exceed the remaining model-call budget.',
    });
  }
  let candidateAvailable = Boolean(state.candidate);
  let review = state.review?.candidateVersion === state.candidateVersion ? state.review : undefined;
  for (const action of plan.actions) {
    if (action.activity === 'model.generate_artifact') {
      if (candidateAvailable) issues.push({
        code: 'REPEATED_ACTION',
        actionId: action.id,
        message: 'A current candidate already exists; review or revise it instead of regenerating.',
      });
      candidateAvailable = true;
      review = undefined;
    } else if (action.activity === 'model.review_artifact') {
      if (!candidateAvailable) issues.push({
        code: 'INVALID_ARGUMENTS',
        actionId: action.id,
        message: 'Review requires a recorded candidate or a dependency on generation in this batch.',
      });
      // The review outcome is not known until observation, so a conditional
      // revision cannot be speculated in this same batch.
      review = undefined;
    } else if (action.activity === 'model.revise_artifact') {
      if (!candidateAvailable || review?.status !== 'revise') issues.push({
        code: 'INVALID_ARGUMENTS',
        actionId: action.id,
        message: 'Revision requires recorded findings for the current candidate from an earlier batch.',
      });
      if (state.revisionCount >= MAX_DYNAMIC_ARTIFACT_REVISIONS) issues.push({
        code: 'ACTION_LIMIT_EXCEEDED',
        actionId: action.id,
        message: `The artifact revision limit of ${MAX_DYNAMIC_ARTIFACT_REVISIONS} is exhausted.`,
      });
      review = undefined;
    }
  }
  return issues;
}

function artifactActionFingerprint(
  action: DynamicExecutionPlan['actions'][number],
  state: ArtifactLoopState,
): string {
  const base = `${dynamicActionFingerprint(action)}:candidate:${state.candidateVersion}`;
  return action.activity === 'model.revise_artifact'
    ? `${base}:review:${canonicalDynamicJson(state.review ?? null)}`
    : base;
}

function qualityFindingCategory(summary: string): DynamicExecutionFinding['category'] {
  const normalized = summary.toLowerCase();
  if (/schema|structured field|json|artifact contract|required file|dockerfile/u.test(normalized)) {
    return 'artifact_contract';
  }
  if (/role|authority|responsibilit/u.test(normalized)) return 'role_fidelity';
  if (/trace|evidence|cite|citation|reference|source/u.test(normalized)) return 'traceability';
  if (/contradic|inconsisten|conflict/u.test(normalized)) return 'consistency';
  if (/fact|assum/u.test(normalized)) return 'fact_assumption';
  if (/block|unresolved|open question/u.test(normalized)) return 'blocking_condition';
  if (/missing|omit|incomplete|complet|required/u.test(normalized)) return 'completeness';
  return 'quality';
}

function appendQualityReviewFindings(
  execution: DynamicArtifactExecutionInput,
  state: ArtifactLoopState,
  actionId: string,
  operationKey: string,
  reviewRequestId: string | undefined,
  summaries: readonly string[],
  categoryOverride?: DynamicExecutionFinding['category'],
): void {
  const existingIds = new Set(state.findings.map((finding) => finding.findingId));
  const evidenceRefs = [
    operationKey,
    `candidate:${state.candidateVersion}`,
    ...(reviewRequestId ? [reviewRequestId] : []),
  ];
  for (const [index, summary] of summaries.entries()) {
    const category = categoryOverride ?? qualityFindingCategory(summary);
    const findingId = `quality:${state.candidateVersion}:${actionId}:${index}`;
    if (existingIds.has(findingId)) continue;
    state.findings.push({
      findingId,
      candidateVersion: state.candidateVersion,
      category,
      severity: category === 'artifact_contract' || category === 'blocking_condition' ? 'high' : 'medium',
      ownerRole: execution.input.role,
      disposition: 'remediate_current',
      summary,
      evidenceRefs,
      raisedByActionId: actionId,
      status: 'open',
    });
    existingIds.add(findingId);
  }
}

function resolveCandidateFindings(
  state: ArtifactLoopState,
  candidateVersion: number,
  resolvedInCandidateVersion: number,
  actionId: string,
  operationKey: string,
): void {
  state.findings = state.findings.map((finding): DynamicExecutionFinding => {
    if (finding.status !== 'open' || finding.candidateVersion !== candidateVersion) return finding;
    return {
      ...finding,
      status: 'resolved',
      evidenceRefs: [...new Set([...finding.evidenceRefs, operationKey])],
      resolvedByActionId: actionId,
      resolvedInCandidateVersion,
    };
  });
}

async function executeArtifactAction(
  execution: DynamicArtifactExecutionInput,
  state: ArtifactLoopState,
  action: DynamicExecutionPlan['actions'][number],
  round: number,
  gateways: DynamicArtifactExecutionGateways,
  inferenceBudget?: DynamicInferenceBudget,
): Promise<DynamicActionObservation> {
  const operationKey = dynamicActionOperationKey(execution.executionId, round, action);
  const contextualFingerprint = artifactActionFingerprint(action, state);
  const common = {
    executionId: execution.executionId,
    round,
    actionId: action.id,
    activity: action.activity,
    activityVersion: action.activityVersion,
    operationKey,
    fingerprint: contextualFingerprint,
  };
  try {
    state.usage = recordModelAttempt(state.usage);
    let result: DynamicAgentModelActionResult;
    let serializedResultBytes: number;
    if (action.activity === 'model.generate_artifact') {
      result = await gateways.act(withDynamicInferenceBudget({
        action: 'generate_candidate',
        input: execution.input,
      }, inferenceBudget), operationKey);
      assertValidActionResult(action, result);
      if (result.action !== 'generate_candidate') throw new Error('Generation returned the wrong action result.');
      state.invocations.push(auditableInvocation(result.invocation));
      state.usage = addModelUsage(state.usage, result.candidate);
      serializedResultBytes = boundedActionResultBytes(action, result);
      state.candidate = result.candidate;
      state.candidateVersion += 1;
      state.review = undefined;
    } else if (action.activity === 'model.review_artifact') {
      if (!state.candidate) throw new Error('Review cannot run without a candidate.');
      result = await gateways.act(withDynamicInferenceBudget({
        action: 'quality_review',
        input: execution.input,
        candidate: state.candidate.content,
        round: state.revisionCount,
      }, inferenceBudget), operationKey);
      assertValidActionResult(action, result);
      if (result.action !== 'quality_review') throw new Error('Review returned the wrong action result.');
      state.invocations.push(auditableInvocation(result.invocation));
      state.usage = addModelUsage(state.usage, result.inference);
      serializedResultBytes = boundedActionResultBytes(action, result);
      state.review = { ...result.review, candidateVersion: state.candidateVersion };
      if (result.review.status === 'revise') {
        appendQualityReviewFindings(
          execution,
          state,
          action.id,
          operationKey,
          result.inference.requestId,
          result.review.findings.length > 0 ? result.review.findings : [result.review.rationale],
        );
      }
    } else if (action.activity === 'model.revise_artifact') {
      if (!state.candidate || !state.review || state.review.candidateVersion !== state.candidateVersion) {
        throw new Error('Revision cannot run without current review findings.');
      }
      result = await gateways.act(withDynamicInferenceBudget({
        action: 'revise_candidate',
        input: execution.input,
        candidate: state.candidate.content,
        review: state.review,
        round: state.revisionCount + 1,
      }, inferenceBudget), operationKey);
      assertValidActionResult(action, result);
      if (result.action !== 'revise_candidate') throw new Error('Revision returned the wrong action result.');
      state.invocations.push(auditableInvocation(result.invocation));
      state.usage = addModelUsage(state.usage, result.candidate);
      serializedResultBytes = boundedActionResultBytes(action, result);
      const reviewedCandidateVersion = state.candidateVersion;
      const revisedCandidateVersion = reviewedCandidateVersion + 1;
      state.candidate = result.candidate;
      state.candidateVersion = revisedCandidateVersion;
      state.revisionCount += 1;
      state.review = undefined;
      resolveCandidateFindings(
        state,
        reviewedCandidateVersion,
        revisedCandidateVersion,
        action.id,
        operationKey,
      );
    } else {
      throw new Error(`No executor is registered for ${action.activity}.`);
    }
    state.usage = { ...state.usage, actions: state.usage.actions + 1 };
    return {
      ...common,
      status: 'succeeded',
      summary: `${action.activity} completed and returned a bounded observation.`,
      result: {
        candidateVersion: state.candidateVersion,
        reviewStatus: state.review?.status ?? null,
      },
      resultBytes: serializedResultBytes,
    };
  } catch (error) {
    state.usage = { ...state.usage, actions: state.usage.actions + 1 };
    return {
      ...common,
      status: 'failed',
      summary: `${action.activity} failed.`,
      error: {
        code: error instanceof ModelUsageAccountingError ? error.code : 'ACTIVITY_FAILED',
        message: failureMessage(error),
        retryable: false,
      },
      resultBytes: 0,
    };
  }
}

function budgetReason(
  state: ArtifactLoopState,
  limits: DynamicExecutionLimits,
  elapsedMs: number,
): string | undefined {
  const exhausted = exhaustedDynamicExecutionLimits(state.usage, limits, elapsedMs);
  return exhausted.length > 0 ? `Execution budget exhausted: ${exhausted.join(', ')}.` : undefined;
}

/**
 * A terminal completion may consume the last available unit of budget. Calls
 * that report more than the configured ceiling are different: they cannot be
 * accepted as completed even if their result otherwise passes verification.
 */
function exceededBudgetReason(
  state: ArtifactLoopState,
  limits: DynamicExecutionLimits,
  elapsedMs: number,
): string | undefined {
  const exceeded: string[] = [];
  if (state.usage.planningRounds > limits.maxPlanningRounds) exceeded.push('planning rounds');
  if (state.usage.actions > limits.maxTotalActions) exceeded.push('actions');
  if (state.usage.modelCalls > limits.maxModelCalls) exceeded.push('model calls');
  if (state.usage.totalTokens > limits.maxTokens) exceeded.push('tokens');
  if (state.usage.cost > limits.maxCost) exceeded.push('cost');
  if (elapsedMs > limits.maxWallClockMs) exceeded.push('wall clock');
  return exceeded.length > 0 ? `Execution budget exceeded: ${exceeded.join(', ')}.` : undefined;
}

function actionBudgetReasonAfterPlanning(
  state: ArtifactLoopState,
  limits: DynamicExecutionLimits,
  elapsedMs: number,
): string | undefined {
  const exhausted: string[] = [];
  if (state.usage.totalTokens >= limits.maxTokens) exhausted.push('tokens');
  if (state.usage.cost > limits.maxCost) exhausted.push('cost');
  if (elapsedMs >= limits.maxWallClockMs) exhausted.push('wall clock');
  return exhausted.length > 0 ? `Execution budget exhausted before actions: ${exhausted.join(', ')}.` : undefined;
}

/**
 * Convert the durable execution ceilings into a one-call provider envelope.
 * The absolute deadline intentionally stays constant for a workflow run: the
 * provider must account for time already spent planning, queueing, and acting.
 */
export function remainingDynamicInferenceBudget(
  execution: Pick<DynamicArtifactExecutionInput, 'enforceProviderBudgets'>,
  state: { usage: DynamicExecutionUsage },
  limits: Pick<DynamicExecutionLimits, 'maxTokens' | 'maxCost' | 'maxWallClockMs'>,
  elapsedMs: number,
  nowEpochMs: number,
): DynamicInferenceBudget | undefined {
  if (!execution.enforceProviderBudgets) return undefined;
  return {
    maxTotalTokens: Math.max(0, limits.maxTokens - state.usage.totalTokens),
    maxCost: Math.max(0, limits.maxCost - state.usage.cost),
    deadlineEpochMs: Math.floor(nowEpochMs + Math.max(0, limits.maxWallClockMs - elapsedMs)),
  };
}

function withDynamicInferenceBudget<T extends object>(
  request: T,
  budget: DynamicInferenceBudget | undefined,
): T & { inferenceBudget?: DynamicInferenceBudget } {
  return budget ? { ...request, inferenceBudget: budget } : request;
}

function skippedObservation(
  executionId: string,
  round: number,
  action: DynamicExecutionPlan['actions'][number],
): DynamicActionObservation {
  return {
    executionId,
    round,
    actionId: action.id,
    activity: action.activity,
    activityVersion: action.activityVersion,
    operationKey: dynamicActionOperationKey(executionId, round, action),
    fingerprint: dynamicActionFingerprint(action),
    status: 'skipped',
    summary: 'A required dependency failed, so this action was not executed.',
    resultBytes: 0,
  };
}

/**
 * Deterministic observe-plan-act-verify loop for one role's artifact order.
 * Model/provider calls are supplied by replay-recorded child Workflow gateways.
 */
export async function executeDynamicArtifactOrder(
  execution: DynamicArtifactExecutionInput,
  gateways: DynamicArtifactExecutionGateways,
): Promise<DynamicArtifactExecutionResult> {
  const parsedLimits = parseLimits(execution.limits);
  const limits = parsedLimits.success ? parsedLimits.data : defaultDynamicExecutionLimits;
  const now = gateways.now ?? Date.now;
  const startedAt = now();
  const freshState: ArtifactLoopState = {
    candidateVersion: 0,
    revisionCount: 0,
    usage: { ...emptyDynamicExecutionUsage },
    observations: [],
    previousActions: [],
    invocations: [],
    plans: [],
    findings: [],
    noProgressRounds: 0,
  };
  const checkpoint = execution.checkpoint;
  const checkpointMismatch = checkpoint && (
    checkpoint.protocolVersion !== DYNAMIC_AGENT_EXECUTION_PROTOCOL_VERSION
    || checkpoint.executionId !== execution.executionId
    || JSON.stringify(checkpoint.limits) !== JSON.stringify(limits)
  );
  const state = checkpoint && !checkpointMismatch
    ? stateFromCheckpoint(checkpoint)
    : freshState;
  if (checkpoint && !checkpointMismatch
    && execution.refreshCandidateAfterHumanDecision
    && state.candidate) {
    state.review = {
      status: 'revise',
      rationale: 'New recorded human direction was added after this candidate was last reviewed.',
      findings: [
        'Revise the candidate to incorporate every newly recorded human decision. Remove questions resolved by that direction and write the selected defaults or assumptions into the artifact.',
      ],
      candidateVersion: state.candidateVersion,
    };
    state.noProgressRounds = 0;
  }
  const elapsedBeforeResume = checkpoint && !checkpointMismatch
    ? Math.max(0, checkpoint.elapsedMs)
    : 0;
  if (!parsedLimits.success) {
    const reason = `Invalid execution limits: ${parsedLimits.error.issues
      .map((issue) => `${issue.path.join('.') || 'limits'}: ${issue.message}`).join('; ')}`;
    return {
      status: 'blocked',
      reason,
      trace: trace(execution.executionId, 'blocked', reason, limits, state),
    };
  }
  if (checkpointMismatch) {
    const reason = 'The dynamic execution checkpoint does not match this execution identity and limit contract.';
    return {
      status: 'blocked',
      reason,
      trace: trace(execution.executionId, 'blocked', reason, limits, freshState),
    };
  }

  const elapsedMs = () => elapsedBeforeResume + Math.max(0, now() - startedAt);
  const inferenceBudget = () => {
    const currentTime = now();
    const currentElapsedMs = elapsedBeforeResume + Math.max(0, currentTime - startedAt);
    return remainingDynamicInferenceBudget(execution, state, limits, currentElapsedMs, currentTime);
  };
  const capabilities = capabilitiesForExecution(execution);

  while (true) {
    const exhaustedBeforePlanning = budgetReason(state, limits, elapsedMs());
    if (exhaustedBeforePlanning) {
      return {
        status: 'budget_exhausted',
        reason: exhaustedBeforePlanning,
        trace: trace(execution.executionId, 'budget_exhausted', exhaustedBeforePlanning, limits, state),
      };
    }

    const round = state.usage.planningRounds + 1;
    let repairAttempt = 0;
    let reasoningRequest = withDynamicInferenceBudget(
      buildDynamicPlanningRequest(execution, state, round),
      inferenceBudget(),
    );
    let acceptedPlan: DynamicExecutionPlan | undefined;

    while (!acceptedPlan) {
      const planOperationKey = `${execution.executionId}/plan/${round}/repair/${repairAttempt}`;
      const exhaustedImmediatelyBeforePlanning = budgetReason(state, limits, elapsedMs());
      if (exhaustedImmediatelyBeforePlanning) {
        return {
          status: 'budget_exhausted',
          reason: exhaustedImmediatelyBeforePlanning,
          trace: trace(
            execution.executionId,
            'budget_exhausted',
            exhaustedImmediatelyBeforePlanning,
            limits,
            state,
          ),
        };
      }
      let result: DynamicModelResult;
      try {
        state.usage = recordModelAttempt(state.usage);
        result = await gateways.reason(reasoningRequest, planOperationKey);
      } catch (error) {
        const reason = `Planning model failed: ${failureMessage(error)}`;
        return {
          status: 'blocked',
          reason,
          trace: trace(execution.executionId, 'blocked', reason, limits, state),
        };
      }
      state.invocations.push(planningInvocation(result, reasoningRequest.purpose as 'plan' | 'plan_repair', round));
      try {
        state.usage = addModelUsage(state.usage, result);
      } catch (error) {
        const reason = `Planning model returned invalid usage: ${failureMessage(error)}`;
        return {
          status: 'blocked',
          reason,
          trace: trace(execution.executionId, 'blocked', reason, limits, state),
        };
      }
      const exceededAfterPlanningCall = exceededBudgetReason(state, limits, elapsedMs());
      if (exceededAfterPlanningCall) {
        return {
          status: 'budget_exhausted',
          reason: exceededAfterPlanningCall,
          trace: trace(execution.executionId, 'budget_exhausted', exceededAfterPlanningCall, limits, state),
        };
      }
      let value: unknown;
      let validationIssues: DynamicPlanValidationIssue[];
      try {
        value = normalizeDecisionEnvelope(normalizeDecisionOptions(
          parseDynamicExecutionPlan(result.content),
          execution.normalizeDecisionOptions,
        ), execution.normalizeDecisionEnvelope);
        const parsedPlan = dynamicExecutionPlanSchema.safeParse(value);
        if (parsedPlan.success) {
          value = normalizeArtifactStateTransitions(bindPlanningContextVersion(discardModelAuthoredArguments(
            serializeArtifactActions(discardTerminalControlActions(
              parsedPlan.data,
              execution.discardTerminalControlActions,
            ), execution.serializeArtifactActions),
            execution.discardModelAuthoredArguments,
          ),
            execution.contextVersion,
            execution.bindPlanningContextVersion,
          ), state, execution, round, execution.normalizeArtifactStateTransitions);
        }
        const validated = validateDynamicExecutionPlan(value, capabilities, {
          limits,
          totalActionsExecuted: state.usage.actions,
          authorityActions: new Set(execution.authorityActions ?? ['EXECUTE_BOUNDED_STEP']),
          previousActions: state.previousActions,
          requiredDecisionIds: execution.requiredDecisionIds ?? [],
          requiredEvidenceRefs: execution.requiredEvidenceRefs ?? [],
          mutationScopes: execution.mutationScopes ?? [],
          contextVersion: execution.contextVersion,
          actionFingerprint: (action) => artifactActionFingerprint(action, state),
        });
        validationIssues = validated.ok ? semanticArtifactPlanIssues(validated.plan, state, limits) : validated.issues;
        if (validated.ok && validationIssues.length === 0) acceptedPlan = validated.plan;
      } catch (error) {
        validationIssues = parseIssues(error);
      }
      state.plans.push(tracePlan(round, repairAttempt, value, Boolean(acceptedPlan), validationIssues));
      if (acceptedPlan) break;
      if (repairAttempt >= limits.maxPlanRepairAttempts) {
        const reason = `Plan validation failed after ${repairAttempt} repair attempt${repairAttempt === 1 ? '' : 's'}: ${validationIssues.map((entry) => entry.message).join(' ')}`;
        return {
          status: 'blocked',
          reason,
          trace: trace(execution.executionId, 'blocked', reason, limits, state),
        };
      }
      repairAttempt += 1;
      state.usage = { ...state.usage, planRepairAttempts: state.usage.planRepairAttempts + 1 };
      reasoningRequest = withDynamicInferenceBudget(
        buildDynamicPlanRepairRequest(
          execution,
          state,
          round,
          repairAttempt,
          result.content,
          validationIssues,
        ),
        inferenceBudget(),
      );
      const exhaustedDuringRepair = budgetReason(state, limits, elapsedMs());
      if (exhaustedDuringRepair) {
        return {
          status: 'budget_exhausted',
          reason: exhaustedDuringRepair,
          trace: trace(execution.executionId, 'budget_exhausted', exhaustedDuringRepair, limits, state),
        };
      }
    }

    state.usage = { ...state.usage, planningRounds: round };
    const plan = acceptedPlan;
    const humanReviewWaived = humanDecisionAcceptsCandidateAtRevisionLimit(plan, state, execution);
    if (humanReviewWaived) {
      recordHumanDecisionReviewWaiver(state, execution);
    }
    if (plan.actions.length > 0) {
      const exhaustedAfterPlanning = actionBudgetReasonAfterPlanning(state, limits, elapsedMs());
      if (exhaustedAfterPlanning) {
        return {
          status: 'budget_exhausted',
          reason: exhaustedAfterPlanning,
          trace: trace(execution.executionId, 'budget_exhausted', exhaustedAfterPlanning, limits, state),
        };
      }
    }
    const beforeProgress = JSON.stringify({
      candidateVersion: state.candidateVersion,
      review: state.review,
    });
    const settled = new Map<string, 'succeeded' | 'failed' | 'skipped'>();
    while (settled.size < plan.actions.length) {
      const scheduled = scheduleDynamicActionWave(
        plan,
        capabilities,
        settled,
        limits.maxConcurrentReadActions,
      );
      for (const blocked of scheduled.blocked) {
        if (settled.has(blocked.id)) continue;
        const observation = skippedObservation(execution.executionId, round, blocked);
        state.observations.push(observation);
        state.previousActions.push({
          actionId: blocked.id,
          fingerprint: observation.fingerprint,
          status: observation.status,
        });
        settled.set(blocked.id, 'skipped');
      }
      if (scheduled.ready.length === 0) {
        if (scheduled.complete || settled.size === plan.actions.length) break;
        const reason = 'The validated action graph could not make deterministic progress.';
        return {
          status: 'blocked',
          reason,
          trace: trace(execution.executionId, 'blocked', reason, limits, state),
        };
      }
      // All current artifact capabilities are mutating workflow state, so the
      // scheduler returns one. Promise.all preserves the generic read-only wave
      // behavior if a future capability is safely classified as read-only.
      const exhaustedImmediatelyBeforeActions = actionBudgetReasonAfterPlanning(state, limits, elapsedMs());
      if (exhaustedImmediatelyBeforeActions) {
        return {
          status: 'budget_exhausted',
          reason: exhaustedImmediatelyBeforeActions,
          trace: trace(
            execution.executionId,
            'budget_exhausted',
            exhaustedImmediatelyBeforeActions,
            limits,
            state,
          ),
        };
      }
      const observations = await Promise.all(scheduled.ready.map((action) =>
        executeArtifactAction(
          execution,
          state,
          action,
          round,
          gateways,
          inferenceBudget(),
        )));
      for (const observation of observations) {
        state.observations.push(observation);
        state.previousActions.push({
          actionId: observation.actionId,
          fingerprint: observation.fingerprint,
          status: observation.status,
        });
        settled.set(observation.actionId, observation.status);
      }
      const accountingFailure = observations.find((observation) =>
        observation.error?.code === 'MODEL_USAGE_UNAVAILABLE'
        || observation.error?.code === 'MODEL_USAGE_INVALID');
      if (accountingFailure) {
        const reason = `Model usage accounting failed: ${accountingFailure.error?.message ?? 'Unknown usage error.'}`;
        return {
          status: 'blocked',
          reason,
          trace: trace(execution.executionId, 'blocked', reason, limits, state),
        };
      }
      const exceededAfterActions = exceededBudgetReason(state, limits, elapsedMs());
      if (exceededAfterActions) {
        return {
          status: 'budget_exhausted',
          reason: exceededAfterActions,
          trace: trace(execution.executionId, 'budget_exhausted', exceededAfterActions, limits, state),
        };
      }
    }

    const updateNoProgress = () => {
      const afterProgress = JSON.stringify({
        candidateVersion: state.candidateVersion,
        review: state.review,
      });
      state.noProgressRounds = beforeProgress === afterProgress ? state.noProgressRounds + 1 : 0;
      return state.noProgressRounds >= limits.maxNoProgressRounds
        ? `No material progress was recorded for ${state.noProgressRounds} consecutive planning rounds.`
        : undefined;
    };

    if (plan.completionCheck.type === 'human_input_required') {
      return {
        status: 'waiting_for_human',
        decision: plan.completionCheck.decision,
        trace: trace(
          execution.executionId,
          'waiting_for_human',
          plan.completionCheck.reason,
          limits,
          state,
          undefined,
          plan.completionCheck.decision,
        ),
        checkpoint: checkpointState(execution.executionId, limits, state, elapsedMs()),
      };
    }
    if (plan.completionCheck.type === 'blocked') {
      return {
        status: 'blocked',
        reason: `${plan.completionCheck.code}: ${plan.completionCheck.reason}`,
        trace: trace(
          execution.executionId,
          'blocked',
          `${plan.completionCheck.code}: ${plan.completionCheck.reason}`,
          limits,
          state,
        ),
      };
    }
    if (plan.completionCheck.type !== 'completed') {
      const reason = updateNoProgress();
      if (reason) {
        return {
          status: 'budget_exhausted',
          reason,
          trace: trace(execution.executionId, 'budget_exhausted', reason, limits, state),
        };
      }
      continue;
    }

    const checks: DynamicCompletionVerification['checks'] = [
      {
        name: 'candidate_exists',
        passed: Boolean(state.candidate),
        evidenceRefs: state.candidate?.requestId ? [state.candidate.requestId] : [],
        reason: state.candidate ? 'A recorded candidate exists.' : 'No candidate exists.',
      },
      {
        name: 'current_quality_review_passed',
        passed: state.review?.status === 'pass' && state.review.candidateVersion === state.candidateVersion,
        evidenceRefs: [],
        reason: state.review?.status === 'pass' && state.review.candidateVersion === state.candidateVersion
          ? 'The current candidate passed independent review.'
          : 'The current candidate has no passing independent review.',
      },
    ];
    let draft: AgentArtifactDraft | undefined;
    if (checks.every((check) => check.passed) && state.candidate) {
      try {
        const finalized = await gateways.act({
          action: 'finalize_candidate',
          input: execution.input,
          candidate: state.candidate,
          modelInvocations: state.invocations,
        }, `${execution.executionId}/verify/${round}/finalize`);
        if (finalized.action !== 'finalize_candidate') throw new Error('Finalization returned the wrong result.');
        draft = humanReviewWaived && execution.deferQuestionsAfterHumanReviewWaiver
          ? { ...finalized.draft, questions: [] }
          : finalized.draft;
        checks.push({
          name: 'artifact_contract_valid',
          passed: true,
          evidenceRefs: [],
          reason: 'The candidate satisfies the deterministic artifact schema.',
        });
        const unresolvedQuestions = draft.questions ?? [];
        checks.push({
          name: 'no_unresolved_human_questions',
          passed: unresolvedQuestions.length === 0,
          evidenceRefs: unresolvedQuestions
            .map((question) => question.decisionKey)
            .filter((decisionKey): decisionKey is string => Boolean(decisionKey)),
          reason: unresolvedQuestions.length === 0
            ? 'The artifact has no unresolved human question.'
            : `The artifact still contains ${unresolvedQuestions.length} unresolved human question${unresolvedQuestions.length === 1 ? '' : 's'}.`,
        });
        const recordedEvidence = new Set<string>([
          ...(execution.availableEvidenceRefs ?? []),
          // The output identity is workflow-owned: artifactType comes from the
          // assigned order and parseAgentArtifact enforces it. Model-selected
          // action IDs and provider request IDs are audit data, not evidence
          // authority, and must never satisfy a required reference by collision.
          execution.input.artifactType,
          `artifact:${execution.input.artifactType}`,
        ]);
        const requiredEvidence = execution.requiredEvidenceRefs ?? [];
        const missingEvidence = requiredEvidence.filter((reference) => !recordedEvidence.has(reference));
        checks.push({
          name: 'required_evidence_resolved',
          passed: missingEvidence.length === 0,
          evidenceRefs: requiredEvidence.filter((reference) => recordedEvidence.has(reference)),
          reason: missingEvidence.length === 0
            ? requiredEvidence.length === 0
              ? 'The order declares no additional evidence references.'
              : 'Every required evidence reference resolves to workflow-supplied evidence or the deterministic output artifact identity.'
            : `Required evidence is not present in workflow-owned records: ${missingEvidence.join(', ')}.`,
        });
      } catch (error) {
        const message = failureMessage(error);
        checks.push({
          name: 'artifact_contract_valid',
          passed: false,
          evidenceRefs: [],
          reason: message,
        });
        state.review = {
          status: 'revise',
          rationale: 'Deterministic completion validation failed.',
          findings: [message],
          candidateVersion: state.candidateVersion,
        };
        appendQualityReviewFindings(
          execution,
          state,
          `verify-${round}`,
          `${execution.executionId}/verify/${round}`,
          state.candidate?.requestId,
          [message],
          'artifact_contract',
        );
      }
    }
    const verification: DynamicCompletionVerification = {
      passed: Boolean(draft) && checks.every((check) => check.passed),
      checks,
    };
    if (!verification.passed || !draft) {
      state.observations.push({
        executionId: execution.executionId,
        round,
        actionId: `verify-${round}`,
        activity: 'control.verify_completion',
        activityVersion: '1.0',
        operationKey: `${execution.executionId}/verify/${round}`,
        fingerprint: `verification:${state.candidateVersion}:${checks.map((check) => check.passed).join(',')}`,
        status: 'failed',
        summary: checks.filter((check) => !check.passed).map((check) => check.reason).join(' '),
        error: {
          code: 'COMPLETION_CHECK_FAILED',
          message: checks.filter((check) => !check.passed).map((check) => check.reason).join(' '),
          retryable: true,
        },
        resultBytes: 0,
      });
      const reason = updateNoProgress();
      if (reason) {
        return {
          status: 'budget_exhausted',
          reason,
          trace: trace(execution.executionId, 'budget_exhausted', reason, limits, state),
        };
      }
      continue;
    }

    const completedTrace = trace(
      execution.executionId,
      'completed',
      plan.completionCheck.reason,
      limits,
      state,
      verification,
    );
    return {
      status: 'completed',
      draft,
      trace: completedTrace,
    };
  }
}
