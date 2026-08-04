import { describe, expect, it } from 'vitest';
import { workerQueuePlan, parseWorkerMode } from './worker-topology.js';

describe('delivery worker topology', () => {
  it('runs project orchestration, side effects, and one worker per agent by default', () => {
    const plan = workerQueuePlan(parseWorkerMode(undefined));

    expect(plan).toHaveLength(16);
    expect(plan.filter((entry) => entry.role)).toHaveLength(14);
    expect(new Set(plan.map((entry) => entry.taskQueue)).size).toBe(plan.length);
    expect(plan[0]?.compatibilityActivities).toBe(true);
  });

  it('can isolate one agent or a safe group in its own process', () => {
    expect(workerQueuePlan('agents', 'builder')).toEqual([
      { kind: 'workflow', taskQueue: 'orchestra-agent-builder', role: 'builder' },
    ]);
    expect(workerQueuePlan('agents', 'release').map((entry) => entry.role)).toEqual([
      'deployment', 'validation',
    ]);
  });

  it('rejects a misspelled worker mode instead of polling an unintended queue', () => {
    expect(() => parseWorkerMode('agnet')).toThrow(/Unknown ORCHESTRA_WORKER_MODE/);
  });
});
