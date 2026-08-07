import { describe, expect, it } from 'vitest';
import {
  bumpOpenRouterBudgets,
  clampOpenRouterBudgets,
  estimatePromptTokens,
  isCompleteJsonObject,
  resolveBudgetHardLimits,
  resolveModelBudgetProfile,
  shouldBumpOpenRouterBudget,
} from './openrouter-budget.js';

describe('OpenRouter budget helpers', () => {
  it('resolves model family profiles', () => {
    expect(resolveModelBudgetProfile('openai/gpt-5-mini')).toMatchObject({
      contextLength: 128_000,
      maxCompletionHardCap: 32_768,
      reasoningSupported: true,
    });
    expect(resolveModelBudgetProfile('openai/gpt-oss-120b')).toMatchObject({
      maxCompletionHardCap: 16_384,
      reasoningSupported: true,
    });
    expect(resolveModelBudgetProfile('anthropic/claude-sonnet-4.6')).toMatchObject({
      contextLength: 200_000,
      maxCompletionHardCap: 16_384,
      reasoningSupported: false,
      reasoningHardCap: 0,
    });
    expect(resolveModelBudgetProfile('qwen/qwen3-coder')).toMatchObject({
      maxCompletionHardCap: 32_768,
      reasoningSupported: true,
    });
    expect(resolveModelBudgetProfile('qwen/qwen3.5-9b')).toMatchObject({
      maxCompletionHardCap: 16_384,
    });
  });

  it('clamps budgets to model, hard limits, and prompt reserve', () => {
    const profile = resolveModelBudgetProfile('qwen/qwen3-coder');
    expect(clampOpenRouterBudgets({
      maxTokens: 100_000,
      reasoningTokens: 20_000,
      profile,
      hardMaxTokens: 32_768,
      hardReasoningTokens: 8_192,
      promptTokens: 1_000,
    })).toEqual({ maxTokens: 32_768, reasoningTokens: 8_192 });

    const claude = resolveModelBudgetProfile('anthropic/claude-sonnet-4.6');
    expect(clampOpenRouterBudgets({
      maxTokens: 4_096,
      reasoningTokens: 512,
      profile: claude,
      hardMaxTokens: 16_384,
      hardReasoningTokens: 0,
      promptTokens: 500,
    })).toEqual({ maxTokens: 4_096, reasoningTokens: 0 });
  });

  it('increments budgets until the hard cap', () => {
    const bumped = bumpOpenRouterBudgets({
      maxTokens: 4_096,
      reasoningTokens: 512,
      hardMaxTokens: 8_192,
      hardReasoningTokens: 2_048,
      budgetBumps: 2,
      incrementRatio: 0.5,
    });
    expect(bumped).toMatchObject({ maxTokens: 6_144, reasoningTokens: 768 });
    expect(bumpOpenRouterBudgets({
      maxTokens: 8_192,
      reasoningTokens: 2_048,
      hardMaxTokens: 8_192,
      hardReasoningTokens: 2_048,
      budgetBumps: 2,
      incrementRatio: 0.5,
    })).toBeUndefined();
  });

  it('detects length cutoffs and incomplete JSON', () => {
    expect(shouldBumpOpenRouterBudget({
      content: '{"content":"ok"}',
      finishReason: 'length',
    })).toBe(true);
    expect(shouldBumpOpenRouterBudget({
      content: '',
      finishReason: 'length',
      nativeFinishReason: 'max_tokens',
    })).toBe(true);
    expect(shouldBumpOpenRouterBudget({
      content: '{"content":',
      finishReason: 'stop',
    })).toBe(true);
    expect(shouldBumpOpenRouterBudget({
      content: '{"content":"ok"}',
      finishReason: 'stop',
    })).toBe(false);
    expect(isCompleteJsonObject('```json\n{"a":1}\n```')).toBe(true);
    expect(estimatePromptTokens([{ role: 'user', content: 'abcd' }])).toBeGreaterThan(0);
    expect(resolveBudgetHardLimits(resolveModelBudgetProfile('qwen/qwen3.5-9b'), {})).toMatchObject({
      hardMaxTokens: 16_384,
      budgetBumps: 2,
    });
  });
});
