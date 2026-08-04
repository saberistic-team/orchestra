import type { ProjectArtifact } from '@orchestra/contracts';
import { describe, expect, it } from 'vitest';
import { summarizeAgentModelUsage } from './AgentOrganism.js';

function artifact(overrides: Partial<ProjectArtifact>): ProjectArtifact {
  return {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    iterationId: crypto.randomUUID(),
    type: 'project-charter',
    name: 'Project charter',
    version: 1,
    content: '# Charter',
    mimeType: 'text/markdown',
    status: 'ready_for_review',
    producedBy: 'manager',
    model: 'qwen/qwen3.5-9b',
    repositoryPath: null,
    repositoryUrl: null,
    createdAt: '2026-08-04T16:00:00.000Z',
    reviewedAt: null,
    ...overrides,
  };
}

describe('selected agent model usage', () => {
  it('totals primary artifacts without double-counting copied attachment metadata', () => {
    const invocation = {
      provider: 'openrouter' as const,
      model: 'qwen/qwen3.5-9b',
      purpose: 'generate' as const,
      round: 0,
      requestId: 'generation-123',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.0025 },
    };
    const result = summarizeAgentModelUsage([
      artifact({ modelProvider: 'openrouter', modelInvocations: [invocation] }),
      artifact({ type: 'user-flow-diagram', modelProvider: 'openrouter', modelInvocations: [invocation] }),
      artifact({
        id: crypto.randomUUID(),
        modelProvider: 'ollama',
        modelInvocations: [{ model: 'qwen3.5:9b', provider: 'ollama', purpose: 'quality_review', round: 0, usage: { promptTokens: 80, completionTokens: 20 } }],
      }),
    ], 'manager', 'project-charter');

    expect(result).toEqual({
      requests: 2,
      totalTokens: 250,
      promptTokens: 180,
      completionTokens: 70,
      openRouterRequests: 1,
      openRouterCost: 0.0025,
      openRouterCostReported: true,
    });
  });
});
