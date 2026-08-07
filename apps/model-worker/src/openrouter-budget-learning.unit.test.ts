import { afterEach, describe, expect, it } from 'vitest';
import {
  applyLearnedStartingBudgets,
  budgetPriorKey,
  configureBudgetPriorStore,
  createMemoryBudgetPriorStore,
  loadBudgetPrior,
  recordSuccessfulBudgetPrior,
  updateBudgetPrior,
  visibleCompletionTokens,
} from './openrouter-budget-learning.js';

afterEach(() => {
  configureBudgetPriorStore(undefined);
});

describe('OpenRouter budget learning', () => {
  it('derives visible completion from total completion minus reasoning', () => {
    expect(visibleCompletionTokens({ completionTokens: 1_000, reasoningTokens: 250 })).toBe(750);
    expect(visibleCompletionTokens({ completionTokens: 800 })).toBe(800);
  });

  it('updates EWMA priors and ignores early outliers', () => {
    const first = updateBudgetPrior(undefined, {
      promptTokens: 1_000,
      completionTokens: 2_000,
      reasoningTokens: 200,
    });
    expect(first).toMatchObject({
      promptEwma: 1_000,
      completionEwma: 1_800,
      reasoningEwma: 200,
      samples: 1,
    });
    const second = updateBudgetPrior(first, {
      promptTokens: 1_200,
      completionTokens: 2_400,
      reasoningTokens: 300,
    });
    expect(second?.samples).toBe(2);
    expect(second?.completionEwma).toBeGreaterThan(first!.completionEwma);
    expect(updateBudgetPrior(second, {
      promptTokens: 1_200,
      completionTokens: 50_000,
      reasoningTokens: 300,
    })).toEqual(second);
  });

  it('raises starting budgets with headroom but never below floors', () => {
    expect(applyLearnedStartingBudgets({
      floorMaxTokens: 4_096,
      floorReasoningTokens: 512,
      prior: {
        promptEwma: 800,
        completionEwma: 6_000,
        reasoningEwma: 900,
        samples: 4,
        updatedAt: new Date().toISOString(),
      },
      headroom: 1.35,
    })).toEqual({
      maxTokens: Math.ceil(6_000 * 1.35),
      reasoningTokens: Math.ceil(900 * 1.35),
    });
    expect(applyLearnedStartingBudgets({
      floorMaxTokens: 4_096,
      floorReasoningTokens: 512,
      prior: {
        promptEwma: 100,
        completionEwma: 500,
        reasoningEwma: 50,
        samples: 2,
        updatedAt: new Date().toISOString(),
      },
      headroom: 1.35,
    })).toEqual({ maxTokens: 4_096, reasoningTokens: 512 });
  });

  it('stores and loads priors from an injected memory store', async () => {
    const store = createMemoryBudgetPriorStore();
    configureBudgetPriorStore(store);
    const request = {
      role: 'builder' as const,
      purpose: 'generate' as const,
      model: 'qwen/qwen3-coder',
    };
    await recordSuccessfulBudgetPrior(request, {
      promptTokens: 2_000,
      completionTokens: 5_000,
      reasoningTokens: 400,
    }, { OPENROUTER_BUDGET_LEARNING: 'true' });
    await expect(loadBudgetPrior(request, { OPENROUTER_BUDGET_LEARNING: 'true' })).resolves.toMatchObject({
      samples: 1,
      completionEwma: 4_600,
      reasoningEwma: 400,
    });
    expect(store.snapshot().has(budgetPriorKey('builder', 'generate', 'qwen/qwen3-coder'))).toBe(true);
  });

  it('skips learning when disabled and tolerates a missing Redis URL', async () => {
    await recordSuccessfulBudgetPrior({
      role: 'builder',
      purpose: 'generate',
      model: 'qwen/qwen3-coder',
    }, { completionTokens: 1_000 }, { OPENROUTER_BUDGET_LEARNING: 'false' });
    await expect(loadBudgetPrior({
      role: 'builder',
      purpose: 'generate',
      model: 'qwen/qwen3-coder',
    }, { OPENROUTER_BUDGET_LEARNING: 'true' })).resolves.toBeUndefined();
  });
});
