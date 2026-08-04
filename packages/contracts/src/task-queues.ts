import type { AgentRole } from './index.js';

/**
 * Stable Temporal task-queue topology.
 *
 * Project workflows retain the original `orchestra-projects` queue so existing
 * executions can continue to make progress while activities and agent work are
 * moved onto independently scalable workers.
 */
export const PROJECT_WORKFLOW_TASK_QUEUE = 'orchestra-projects' as const;
export const PROJECT_ACTIVITY_TASK_QUEUE = 'orchestra-project-activities' as const;
export const VALIDATION_TASK_QUEUE = 'orchestra-validation' as const;
export const MODEL_ROUTING_TASK_QUEUE = 'orchestra-model-routing' as const;
export const OLLAMA_INFERENCE_TASK_QUEUE = 'orchestra-ollama-inference' as const;
export const OPENROUTER_INFERENCE_TASK_QUEUE = 'orchestra-openrouter-inference' as const;

/** Queues used before the split topology, exported for explicit migrations. */
export const LEGACY_PROJECT_TASK_QUEUE = PROJECT_WORKFLOW_TASK_QUEUE;
export const LEGACY_MODEL_TASK_QUEUE = 'orchestra-models' as const;

const agentRoles = [
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

const agentRoleSet: ReadonlySet<string> = new Set(agentRoles);

const roleGroups = {
  all: agentRoles,
  iteration: agentRoles.filter((role) => role !== 'deployment' && role !== 'validation'),
  release: ['deployment', 'validation'],
  shape: ['manager', 'requirements', 'product'],
  design: ['ux', 'architecture', 'data', 'security'],
  plan: ['planner'],
  build: ['builder'],
  assure: ['test', 'reviewer', 'gate', 'deployment', 'validation'],
} as const satisfies Readonly<Record<string, readonly AgentRole[]>>;

export type AgentRoleSelector = keyof typeof roleGroups;

export function agentTaskQueue(role: AgentRole): `orchestra-agent-${AgentRole}` {
  return `orchestra-agent-${role}`;
}

export function agentModelTaskQueue(role: AgentRole): `orchestra-model-${AgentRole}` {
  return `orchestra-model-${role}`;
}

export const ALL_AGENT_TASK_QUEUES = Object.freeze(agentRoles.map(agentTaskQueue));
export const ALL_AGENT_MODEL_TASK_QUEUES = Object.freeze(agentRoles.map(agentModelTaskQueue));

const agentRoleByTaskQueue: ReadonlyMap<string, AgentRole> = new Map(
  agentRoles.map((role) => [agentTaskQueue(role), role] as const),
);
const agentRoleByModelTaskQueue: ReadonlyMap<string, AgentRole> = new Map(
  agentRoles.map((role) => [agentModelTaskQueue(role), role] as const),
);

/** Returns a role only for an exact, known agent queue name. */
export function parseAgentTaskQueueRole(value: unknown): AgentRole | undefined {
  return typeof value === 'string' ? agentRoleByTaskQueue.get(value) : undefined;
}

/** Returns a role only for an exact, known model/brain queue name. */
export function parseAgentModelTaskQueueRole(value: unknown): AgentRole | undefined {
  return typeof value === 'string' ? agentRoleByModelTaskQueue.get(value) : undefined;
}

/**
 * Parses a worker's comma-separated role configuration.
 *
 * Blank input means every role. Besides individual roles, callers can use
 * `all`, `iteration`, `release`, or a delivery phase (`shape`, `design`,
 * `plan`, `build`, `assure`). Results are de-duplicated in canonical delivery
 * order. Invalid or empty selectors throw so a worker cannot silently claim an
 * unintended subset of queues.
 */
export function parseAgentRoles(value?: string): AgentRole[] {
  if (value === undefined || value.trim() === '') return [...agentRoles];

  const requested = new Set<AgentRole>();
  const tokens = value.split(',').map((token) => token.trim().toLowerCase());

  for (const token of tokens) {
    if (token === '') {
      throw new RangeError('Agent role selectors must not contain empty values.');
    }

    if (Object.prototype.hasOwnProperty.call(roleGroups, token)) {
      for (const role of roleGroups[token as AgentRoleSelector]) requested.add(role);
      continue;
    }

    if (agentRoleSet.has(token)) {
      requested.add(token as AgentRole);
      continue;
    }

    throw new RangeError(`Unknown agent role or group: ${token}`);
  }

  return agentRoles.filter((role) => requested.has(role));
}
