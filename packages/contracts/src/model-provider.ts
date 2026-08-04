import { organismAgentRoles } from './agent-organism.js';

export type ModelProvider = 'ollama' | 'openrouter';

type OrganismRole = (typeof organismAgentRoles)[number];

/** Local Ollama tags used when MODEL_PROVIDER=ollama. */
export const DEFAULT_OLLAMA_MODELS = {
  manager: 'qwen3.5:9b',
  requirements: 'qwen3.5:9b',
  product: 'qwen3.5:9b',
  ux: 'qwen3.5:9b',
  architecture: 'qwen3.5:27b',
  data: 'qwen3.5:27b',
  security: 'gpt-oss:20b',
  planner: 'qwen3.5:27b',
  builder: 'qwen2.5-coder:32b',
  test: 'qwen2.5-coder:32b',
  reviewer: 'gpt-oss:20b',
  gate: 'gpt-oss:20b',
  deployment: 'gpt-oss:20b',
  validation: 'qwen3.5:9b',
} as const satisfies Record<OrganismRole, string>;

/** OpenRouter model IDs used when MODEL_PROVIDER=openrouter. */
export const DEFAULT_OPENROUTER_MODELS = {
  manager: 'qwen/qwen3.5-9b',
  requirements: 'qwen/qwen3.5-27b',
  product: 'qwen/qwen3.5-9b',
  ux: 'qwen/qwen3.5-9b',
  architecture: 'qwen/qwen3.5-27b',
  data: 'qwen/qwen3.5-27b',
  security: 'openai/gpt-oss-120b',
  planner: 'qwen/qwen3.5-27b',
  builder: 'qwen/qwen3-coder',
  test: 'qwen/qwen3-coder',
  reviewer: 'anthropic/claude-sonnet-4.6',
  gate: 'openai/gpt-oss-120b',
  deployment: 'openai/gpt-oss-120b',
  validation: 'qwen/qwen3.5-9b',
} as const satisfies Record<OrganismRole, string>;

export const DEFAULT_OPENROUTER_MODEL = DEFAULT_OPENROUTER_MODELS.manager;
export const DEFAULT_OLLAMA_MODEL = DEFAULT_OLLAMA_MODELS.manager;

export function parseModelProvider(value: string | undefined): ModelProvider {
  const normalized = (value ?? 'ollama').trim().toLowerCase();
  if (normalized === 'openrouter') return 'openrouter';
  if (normalized === 'ollama' || normalized === '') return 'ollama';
  throw new Error(`Unsupported MODEL_PROVIDER "${value}". Use ollama or openrouter.`);
}

/** Local Ollama must stay single-flight; hosted OpenRouter may run in parallel. */
export function modelProviderSerializesInference(provider: ModelProvider): boolean {
  return provider === 'ollama';
}

export type ModelProviderEnv = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveModelProvider(
  role: OrganismRole,
  env: ModelProviderEnv = {},
): ModelProvider {
  return parseModelProvider(nonEmpty(env[`MODEL_PROVIDER_${role.toUpperCase()}`]) ?? env.MODEL_PROVIDER);
}

export function resolveModelConcurrency(
  env: ModelProviderEnv = {},
  provider: ModelProvider = parseModelProvider(env.MODEL_PROVIDER),
): number {
  if (provider === 'ollama') return 1;
  const configured = Number(env.MODEL_INFERENCE_CONCURRENCY);
  if (Number.isFinite(configured) && configured >= 1) return Math.min(64, Math.floor(configured));
  return 8;
}

export function resolveAssignedModel(
  role: OrganismRole,
  env: ModelProviderEnv = {},
): string {
  const provider = resolveModelProvider(role, env);
  if (provider === 'openrouter') {
    return env[`OPENROUTER_MODEL_${role.toUpperCase()}`]
      ?? env.OPENROUTER_MODEL_DEFAULT
      ?? DEFAULT_OPENROUTER_MODELS[role]
      ?? DEFAULT_OPENROUTER_MODEL;
  }
  return env[`OLLAMA_MODEL_${role.toUpperCase()}`]
    ?? env.OLLAMA_MODEL_DEFAULT
    ?? DEFAULT_OLLAMA_MODELS[role]
    ?? DEFAULT_OLLAMA_MODEL;
}

export interface InferenceRoutingPolicy {
  provider: ModelProvider;
  model: string;
  serialize: boolean;
  concurrency: number;
}

export function resolveInferenceRoutingPolicy(
  role: OrganismRole,
  env: ModelProviderEnv = {},
): InferenceRoutingPolicy {
  const provider = resolveModelProvider(role, env);
  return {
    provider,
    model: resolveAssignedModel(role, env),
    serialize: modelProviderSerializesInference(provider),
    concurrency: resolveModelConcurrency(env, provider),
  };
}
