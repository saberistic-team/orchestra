import { createClient, type RedisClientType } from 'redis';
import type { BoundInferenceRequest, ModelTokenUsage } from './model-protocol.js';

const DEFAULT_HEADROOM = 1.35;
const DEFAULT_ALPHA = 0.2;
const OUTLIER_MULTIPLIER = 3;
const OUTLIER_MIN_SAMPLES = 20;
const PRIOR_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface OpenRouterBudgetPrior {
  promptEwma: number;
  completionEwma: number;
  reasoningEwma: number;
  samples: number;
  updatedAt: string;
}

export interface BudgetPriorStore {
  get(key: string): Promise<OpenRouterBudgetPrior | undefined>;
  set(key: string, prior: OpenRouterBudgetPrior): Promise<void>;
}

export function openRouterBudgetLearningEnabled(environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.OPENROUTER_BUDGET_LEARNING?.trim().toLowerCase();
  if (configured === 'false' || configured === '0' || configured === 'off') return false;
  return true;
}

export function openRouterBudgetHeadroom(environment: NodeJS.ProcessEnv = process.env) {
  const normalized = environment.OPENROUTER_BUDGET_HEADROOM?.trim();
  if (!normalized) return DEFAULT_HEADROOM;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) {
    throw new Error('OPENROUTER_BUDGET_HEADROOM must be a number between 1 and 3.');
  }
  return parsed;
}

export function budgetPriorKey(
  role: BoundInferenceRequest['role'],
  purpose: BoundInferenceRequest['purpose'],
  model: string,
) {
  return `orchestra:openrouter-budget:${role}:${purpose}:${model}`;
}

export function visibleCompletionTokens(usage: Pick<ModelTokenUsage, 'completionTokens' | 'reasoningTokens'>) {
  const completion = usage.completionTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  if (!Number.isFinite(completion) || completion < 0) return 0;
  if (!Number.isFinite(reasoning) || reasoning <= 0) return Math.ceil(completion);
  return Math.max(0, Math.ceil(completion - reasoning));
}

function ewma(previous: number, observed: number, alpha = DEFAULT_ALPHA) {
  if (!Number.isFinite(previous) || previous <= 0) return observed;
  return alpha * observed + (1 - alpha) * previous;
}

export function updateBudgetPrior(
  prior: OpenRouterBudgetPrior | undefined,
  observed: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
  },
): OpenRouterBudgetPrior | undefined {
  const prompt = observed.promptTokens ?? 0;
  const completion = visibleCompletionTokens(observed);
  const reasoning = Math.max(0, observed.reasoningTokens ?? 0);
  if (prompt <= 0 && completion <= 0 && reasoning <= 0) return prior;

  if (prior && prior.samples < OUTLIER_MIN_SAMPLES) {
    const outlier = (
      (prior.completionEwma > 0 && completion > prior.completionEwma * OUTLIER_MULTIPLIER)
      || (prior.reasoningEwma > 0 && reasoning > prior.reasoningEwma * OUTLIER_MULTIPLIER)
      || (prior.promptEwma > 0 && prompt > prior.promptEwma * OUTLIER_MULTIPLIER)
    );
    if (outlier) return prior;
  }

  return {
    promptEwma: ewma(prior?.promptEwma ?? 0, prompt),
    completionEwma: ewma(prior?.completionEwma ?? 0, completion),
    reasoningEwma: ewma(prior?.reasoningEwma ?? 0, reasoning),
    samples: (prior?.samples ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
}

/** Raise floors with learned / in-workflow usage; never shrink below role defaults. */
export function applyLearnedStartingBudgets(input: {
  floorMaxTokens: number;
  floorReasoningTokens: number;
  prior?: OpenRouterBudgetPrior | null;
  sessionUsage?: Pick<ModelTokenUsage, 'completionTokens' | 'reasoningTokens'> | null;
  headroom: number;
}): { maxTokens: number; reasoningTokens: number } {
  const sessionCompletion = input.sessionUsage
    ? visibleCompletionTokens(input.sessionUsage)
    : 0;
  const sessionReasoning = Math.max(0, input.sessionUsage?.reasoningTokens ?? 0);
  const learnedCompletion = Math.max(
    input.floorMaxTokens,
    input.prior?.completionEwma ? Math.ceil(input.prior.completionEwma * input.headroom) : 0,
    sessionCompletion ? Math.ceil(sessionCompletion * input.headroom) : 0,
  );
  const learnedReasoning = Math.max(
    input.floorReasoningTokens,
    input.prior?.reasoningEwma ? Math.ceil(input.prior.reasoningEwma * input.headroom) : 0,
    sessionReasoning ? Math.ceil(sessionReasoning * input.headroom) : 0,
  );
  return {
    maxTokens: learnedCompletion,
    reasoningTokens: learnedReasoning,
  };
}

export function createMemoryBudgetPriorStore(
  initial: Iterable<[string, OpenRouterBudgetPrior]> = [],
): BudgetPriorStore & { snapshot(): Map<string, OpenRouterBudgetPrior> } {
  const values = new Map<string, OpenRouterBudgetPrior>(initial);
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, prior) {
      values.set(key, prior);
    },
    snapshot() {
      return new Map(values);
    },
  };
}

let redisClient: RedisClientType | undefined;
let redisConnectPromise: Promise<RedisClientType | undefined> | undefined;
let configuredStore: BudgetPriorStore | undefined;

/** Test seam for injecting an in-memory prior store. */
export function configureBudgetPriorStore(store: BudgetPriorStore | undefined) {
  configuredStore = store;
}

async function connectRedis(url: string): Promise<RedisClientType | undefined> {
  if (redisClient?.isOpen) return redisClient;
  if (!redisConnectPromise) {
    redisConnectPromise = (async () => {
      try {
        const client = createClient({
          url,
          socket: {
            connectTimeout: 1_000,
            reconnectStrategy: false,
          },
        }) as RedisClientType;
        client.on('error', () => {
          // Errors are surfaced on command failure; keep inference non-fatal.
        });
        await client.connect();
        redisClient = client;
        return client;
      } catch {
        redisClient = undefined;
        return undefined;
      } finally {
        redisConnectPromise = undefined;
      }
    })();
  }
  return await redisConnectPromise;
}

function createRedisBudgetPriorStore(url: string): BudgetPriorStore {
  return {
    async get(key) {
      const client = await connectRedis(url);
      if (!client) return undefined;
      try {
        const raw = await client.get(key);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as OpenRouterBudgetPrior;
        if (!parsed || typeof parsed !== 'object') return undefined;
        if (![parsed.promptEwma, parsed.completionEwma, parsed.reasoningEwma, parsed.samples]
          .every((value) => typeof value === 'number' && Number.isFinite(value))) {
          return undefined;
        }
        return parsed;
      } catch {
        return undefined;
      }
    },
    async set(key, prior) {
      const client = await connectRedis(url);
      if (!client) return;
      try {
        await client.set(key, JSON.stringify(prior), { EX: PRIOR_TTL_SECONDS });
      } catch {
        // Learning must never fail the inference path.
      }
    },
  };
}

export function resolveBudgetPriorStore(environment: NodeJS.ProcessEnv = process.env): BudgetPriorStore | undefined {
  if (configuredStore) return configuredStore;
  if (!openRouterBudgetLearningEnabled(environment)) return undefined;
  const redisUrl = environment.REDIS_URL?.trim();
  if (!redisUrl) return undefined;
  return createRedisBudgetPriorStore(redisUrl);
}

export async function loadBudgetPrior(
  request: Pick<BoundInferenceRequest, 'role' | 'purpose' | 'model'>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const store = resolveBudgetPriorStore(environment);
  if (!store) return undefined;
  try {
    return await store.get(budgetPriorKey(request.role, request.purpose, request.model));
  } catch {
    return undefined;
  }
}

export async function recordSuccessfulBudgetPrior(
  request: Pick<BoundInferenceRequest, 'role' | 'purpose' | 'model'>,
  usage: ModelTokenUsage | undefined,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (!usage) return;
  const store = resolveBudgetPriorStore(environment);
  if (!store) return;
  const key = budgetPriorKey(request.role, request.purpose, request.model);
  try {
    const current = await store.get(key);
    const next = updateBudgetPrior(current, usage);
    if (next) await store.set(key, next);
  } catch {
    // Learning must never fail the inference path.
  }
}
