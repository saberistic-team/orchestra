import {
  PROJECT_ACTIVITY_TASK_QUEUE,
  PROJECT_WORKFLOW_TASK_QUEUE,
  agentTaskQueue,
  parseAgentRoles,
  type AgentRole,
} from '@orchestra/contracts';

export type OrchestraWorkerMode = 'all' | 'project' | 'activities' | 'agents';

export interface WorkerQueuePlan {
  kind: 'workflow' | 'activity';
  taskQueue: string;
  role?: AgentRole;
  compatibilityActivities?: boolean;
}

export function parseWorkerMode(value: string | undefined): OrchestraWorkerMode {
  const normalized = value?.trim().toLowerCase() || 'all';
  if (normalized === 'all' || normalized === 'project' || normalized === 'activities' || normalized === 'agents') {
    return normalized;
  }
  throw new Error(`Unknown ORCHESTRA_WORKER_MODE "${value}". Expected all, project, activities, or agents.`);
}

/**
 * Produces one logical Temporal Worker per queue. A process may run the whole
 * plan for local development or only one slice in production. Selecting one
 * role gives that agent a physically isolated process without changing any
 * workflow IDs or histories.
 */
export function workerQueuePlan(
  mode: OrchestraWorkerMode,
  roleSelector?: string,
): WorkerQueuePlan[] {
  const plan: WorkerQueuePlan[] = [];
  if (mode === 'all' || mode === 'project') {
    plan.push({
      kind: 'workflow',
      taskQueue: PROJECT_WORKFLOW_TASK_QUEUE,
      compatibilityActivities: true,
    });
  }
  if (mode === 'all' || mode === 'activities') {
    plan.push({ kind: 'activity', taskQueue: PROJECT_ACTIVITY_TASK_QUEUE });
  }
  if (mode === 'all' || mode === 'agents') {
    for (const role of parseAgentRoles(roleSelector)) {
      plan.push({ kind: 'workflow', taskQueue: agentTaskQueue(role), role });
    }
  }
  return plan;
}
