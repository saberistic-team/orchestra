import type { BoundInferenceRequest, OllamaMessage } from './model-protocol.js';

const CONTEXT_SAFETY_TOKENS = 1_024;
const REASONING_OUTPUT_RESERVE = 512;
const DEFAULT_ENV_MAX_TOKENS_HARD_LIMIT = 32_768;
const DEFAULT_ENV_REASONING_HARD_LIMIT = 8_192;
const DEFAULT_BUDGET_BUMPS = 2;
const DEFAULT_INCREMENT_RATIO = 0.5;
const MIN_MAX_TOKEN_STEP = 2_048;
const MIN_REASONING_STEP = 1_024;

export interface OpenRouterModelBudgetProfile {
  contextLength: number;
  maxCompletionHardCap: number;
  reasoningSupported: boolean;
  reasoningHardCap: number;
}

export interface OpenRouterBudgetState {
  maxTokens: number;
  reasoningTokens: number;
  hardMaxTokens: number;
  hardReasoningTokens: number;
  budgetBumps: number;
  incrementRatio: number;
}

export function resolveModelBudgetProfile(model: string): OpenRouterModelBudgetProfile {
  const id = model.trim().toLowerCase();
  if (id.startsWith('openai/gpt-5')) {
    return {
      contextLength: 128_000,
      maxCompletionHardCap: 32_768,
      reasoningSupported: true,
      reasoningHardCap: 8_192,
    };
  }
  if (id.startsWith('openai/gpt-oss')) {
    return {
      contextLength: 128_000,
      maxCompletionHardCap: 16_384,
      reasoningSupported: true,
      reasoningHardCap: 4_096,
    };
  }
  if (id.startsWith('anthropic/claude')) {
    return {
      contextLength: 200_000,
      maxCompletionHardCap: 16_384,
      reasoningSupported: false,
      reasoningHardCap: 0,
    };
  }
  if (id.startsWith('qwen/qwen3-coder') || id.includes('qwen3-coder')) {
    return {
      contextLength: 128_000,
      maxCompletionHardCap: 32_768,
      reasoningSupported: true,
      reasoningHardCap: 8_192,
    };
  }
  if (id.startsWith('qwen/')) {
    return {
      contextLength: 128_000,
      maxCompletionHardCap: 16_384,
      reasoningSupported: true,
      reasoningHardCap: 4_096,
    };
  }
  return {
    contextLength: 128_000,
    maxCompletionHardCap: 16_384,
    reasoningSupported: true,
    reasoningHardCap: 4_096,
  };
}

/** Cheap reservation estimate; usage from a prior attempt can refine it. */
export function estimatePromptTokens(messages: OllamaMessage[], observedPromptTokens?: number) {
  if (observedPromptTokens !== undefined && Number.isFinite(observedPromptTokens) && observedPromptTokens > 0) {
    return Math.ceil(observedPromptTokens);
  }
  const characters = messages.reduce((total, message) => total + message.content.length + message.role.length + 8, 0);
  return Math.max(1, Math.ceil(characters / 4));
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, name: string) {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, maximum: number, name: string) {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return parsed;
}

function ratio(value: string | undefined, fallback: number, name: string) {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 2) {
    throw new Error(`${name} must be a number greater than 0 and at most 2.`);
  }
  return parsed;
}

export function resolveBudgetHardLimits(
  profile: OpenRouterModelBudgetProfile,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const envMax = positiveInteger(
    environment.OPENROUTER_MAX_TOKENS_HARD_LIMIT,
    DEFAULT_ENV_MAX_TOKENS_HARD_LIMIT,
    131_072,
    'OpenRouter max tokens hard limit',
  );
  const envReasoning = nonNegativeInteger(
    environment.OPENROUTER_REASONING_MAX_TOKENS_HARD_LIMIT,
    DEFAULT_ENV_REASONING_HARD_LIMIT,
    65_536,
    'OpenRouter reasoning max tokens hard limit',
  );
  const budgetBumps = nonNegativeInteger(
    environment.OPENROUTER_BUDGET_BUMPS,
    DEFAULT_BUDGET_BUMPS,
    5,
    'OpenRouter budget bumps',
  );
  const incrementRatio = ratio(
    environment.OPENROUTER_BUDGET_INCREMENT_RATIO,
    DEFAULT_INCREMENT_RATIO,
    'OpenRouter budget increment ratio',
  );
  return {
    hardMaxTokens: Math.min(envMax, profile.maxCompletionHardCap),
    hardReasoningTokens: profile.reasoningSupported
      ? Math.min(envReasoning, profile.reasoningHardCap)
      : 0,
    budgetBumps,
    incrementRatio,
  };
}

export function clampOpenRouterBudgets(input: {
  maxTokens: number;
  reasoningTokens: number;
  profile: OpenRouterModelBudgetProfile;
  hardMaxTokens: number;
  hardReasoningTokens: number;
  promptTokens: number;
}): { maxTokens: number; reasoningTokens: number } {
  const availableCompletion = Math.max(
    256,
    input.profile.contextLength - input.promptTokens - CONTEXT_SAFETY_TOKENS,
  );
  const maxTokens = Math.max(
    256,
    Math.min(input.maxTokens, input.hardMaxTokens, availableCompletion),
  );
  if (!input.profile.reasoningSupported || input.hardReasoningTokens === 0) {
    return { maxTokens, reasoningTokens: 0 };
  }
  const reasoningCap = Math.min(
    input.reasoningTokens,
    input.hardReasoningTokens,
    Math.max(0, maxTokens - REASONING_OUTPUT_RESERVE),
  );
  return { maxTokens, reasoningTokens: Math.max(0, reasoningCap) };
}

export function bumpOpenRouterBudgets(state: OpenRouterBudgetState): OpenRouterBudgetState | undefined {
  const maxStep = Math.max(MIN_MAX_TOKEN_STEP, Math.floor(state.maxTokens * state.incrementRatio));
  const nextMax = Math.min(state.hardMaxTokens, state.maxTokens + maxStep);
  // Output cutoffs need a larger completion budget; reasoning-only growth is not progress.
  if (nextMax <= state.maxTokens) return undefined;
  let nextReasoning = state.reasoningTokens;
  if (state.reasoningTokens > 0 && state.hardReasoningTokens > 0) {
    const reasoningStep = Math.min(
      MIN_REASONING_STEP,
      Math.max(1, Math.floor(state.reasoningTokens * state.incrementRatio)),
    );
    nextReasoning = Math.min(
      state.hardReasoningTokens,
      Math.max(0, nextMax - REASONING_OUTPUT_RESERVE),
      state.reasoningTokens + reasoningStep,
    );
  } else {
    nextReasoning = 0;
  }
  return {
    ...state,
    maxTokens: nextMax,
    reasoningTokens: nextReasoning,
  };
}

export function isLengthFinishReason(finishReason?: string, nativeFinishReason?: string) {
  const reasons = [finishReason, nativeFinishReason]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  return reasons.some((reason) => (
    reason === 'length'
    || reason === 'max_tokens'
    || reason === 'max_completion_tokens'
    || reason.includes('length')
  ));
}

/** Structural completeness only — not full artifact validation. */
export function isCompleteJsonObject(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export function shouldBumpOpenRouterBudget(input: {
  content: string | undefined;
  finishReason?: string;
  nativeFinishReason?: string;
}): boolean {
  const lengthBound = isLengthFinishReason(input.finishReason, input.nativeFinishReason);
  const content = input.content?.trim() ?? '';
  if (!content) return lengthBound;
  if (lengthBound) return true;
  return !isCompleteJsonObject(content);
}

export function budgetProgressDetails(
  request: Pick<BoundInferenceRequest, 'role' | 'purpose' | 'model'>,
  state: Pick<OpenRouterBudgetState, 'maxTokens' | 'reasoningTokens'>,
  budgetAttempt: number,
) {
  return {
    stage: 'budget',
    role: request.role,
    purpose: request.purpose,
    model: request.model,
    budgetAttempt,
    maxTokens: state.maxTokens,
    reasoningTokens: state.reasoningTokens,
  };
}
