import { describe, expect, it } from 'vitest';
import { modelWorkerQueuePlan, parseModelWorkerMode } from './worker-topology.js';

describe('model worker topology', () => {
  it('runs every brain, the legacy replay bridge, and inference by default', () => {
    const plan = modelWorkerQueuePlan(parseModelWorkerMode(undefined));
    expect(plan.filter((entry) => entry.kind === 'brain')).toHaveLength(14);
    expect(plan).toContainEqual({ kind: 'compatibility', taskQueue: 'orchestra-models' });
    expect(plan).toContainEqual({ kind: 'routing', taskQueue: 'orchestra-model-routing' });
    expect(plan).toContainEqual({ kind: 'ollama-inference', taskQueue: 'orchestra-ollama-inference' });
    expect(plan).toContainEqual({ kind: 'openrouter-inference', taskQueue: 'orchestra-openrouter-inference' });
  });

  it('selects individual roles or groups while retaining legacy replay polling', () => {
    expect(modelWorkerQueuePlan('brains', 'builder')).toEqual([
      { kind: 'brain', taskQueue: 'orchestra-model-builder', role: 'builder' },
      { kind: 'compatibility', taskQueue: 'orchestra-models' },
    ]);
    expect(modelWorkerQueuePlan('brains', 'release').filter((entry) => entry.role).map((entry) => entry.role))
      .toEqual(['deployment', 'validation']);
  });

  it('can isolate the singleton inference lane or legacy compatibility worker', () => {
    expect(modelWorkerQueuePlan('inference')).toEqual([
      { kind: 'routing', taskQueue: 'orchestra-model-routing' },
      { kind: 'ollama-inference', taskQueue: 'orchestra-ollama-inference' },
      { kind: 'openrouter-inference', taskQueue: 'orchestra-openrouter-inference' },
    ]);
    expect(modelWorkerQueuePlan('compat', undefined, 'custom-model-legacy')).toEqual([
      { kind: 'compatibility', taskQueue: 'custom-model-legacy' },
    ]);
  });

  it('rejects invalid modes and role selectors', () => {
    expect(() => parseModelWorkerMode('brain')).toThrow(/Unknown MODEL_WORKER_MODE/);
    expect(() => modelWorkerQueuePlan('brains', 'buidler')).toThrow(/Unknown agent role or group/);
  });
});
