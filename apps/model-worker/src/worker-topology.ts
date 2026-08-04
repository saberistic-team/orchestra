import {
  LEGACY_MODEL_TASK_QUEUE,
  MODEL_ROUTING_TASK_QUEUE,
  OLLAMA_INFERENCE_TASK_QUEUE,
  OPENROUTER_INFERENCE_TASK_QUEUE,
  agentModelTaskQueue,
  parseAgentRoles,
  type AgentRole,
} from '@orchestra/contracts';

export type ModelWorkerMode = 'brains' | 'routing' | 'ollama-inference' | 'openrouter-inference' | 'inference' | 'all' | 'compat';

export interface ModelWorkerQueuePlan {
  kind: 'brain' | 'routing' | 'ollama-inference' | 'openrouter-inference' | 'compatibility';
  taskQueue: string;
  role?: AgentRole;
}

export function parseModelWorkerMode(value: string | undefined): ModelWorkerMode {
  const normalized = value?.trim().toLowerCase() || 'all';
  if (['brains', 'routing', 'ollama-inference', 'openrouter-inference', 'inference', 'all', 'compat'].includes(normalized)) {
    return normalized as ModelWorkerMode;
  }
  throw new Error(`Unknown MODEL_WORKER_MODE "${value}". Expected brains, routing, ollama-inference, openrouter-inference, inference, all, or compat.`);
}

/**
 * Builds an explicit process-local polling plan. Brain selection can be a role
 * or a group accepted by parseAgentRoles; compatibility polling remains on for
 * every brain process so pre-migration Activity histories can finish.
 */
export function modelWorkerQueuePlan(
  mode: ModelWorkerMode,
  roleSelector?: string,
  legacyTaskQueue: string = LEGACY_MODEL_TASK_QUEUE,
): ModelWorkerQueuePlan[] {
  const plan: ModelWorkerQueuePlan[] = [];
  if (mode === 'all' || mode === 'brains') {
    for (const role of parseAgentRoles(roleSelector)) {
      plan.push({ kind: 'brain', taskQueue: agentModelTaskQueue(role), role });
    }
    plan.push({ kind: 'compatibility', taskQueue: legacyTaskQueue });
  }
  if (mode === 'all' || mode === 'routing' || mode === 'inference') {
    plan.push({ kind: 'routing', taskQueue: MODEL_ROUTING_TASK_QUEUE });
  }
  if (mode === 'all' || mode === 'ollama-inference' || mode === 'inference') {
    plan.push({ kind: 'ollama-inference', taskQueue: OLLAMA_INFERENCE_TASK_QUEUE });
  }
  if (mode === 'all' || mode === 'openrouter-inference' || mode === 'inference') {
    plan.push({ kind: 'openrouter-inference', taskQueue: OPENROUTER_INFERENCE_TASK_QUEUE });
  }
  if (mode === 'compat') {
    plan.push({ kind: 'compatibility', taskQueue: legacyTaskQueue });
  }
  return plan;
}
