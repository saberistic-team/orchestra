import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENROUTER_MODELS,
  parseModelProvider,
  resolveAssignedModel,
  resolveInferenceRoutingPolicy,
  resolveModelConcurrency,
} from './model-provider.js';

describe('model provider routing', () => {
  it('defaults to serialized local Ollama', () => {
    expect(parseModelProvider(undefined)).toBe('ollama');
    expect(resolveInferenceRoutingPolicy('manager', {})).toEqual({
      provider: 'ollama',
      model: 'qwen3.5:9b',
      serialize: true,
      concurrency: 1,
    });
  });

  it('enables parallel OpenRouter routing with suggested role models', () => {
    const env = { MODEL_PROVIDER: 'openrouter' };
    expect(resolveInferenceRoutingPolicy('manager', env)).toEqual({
      provider: 'openrouter',
      model: DEFAULT_OPENROUTER_MODELS.manager,
      serialize: false,
      concurrency: 8,
    });
    expect(resolveAssignedModel('builder', env)).toBe(DEFAULT_OPENROUTER_MODELS.builder);
    expect(resolveAssignedModel('reviewer', env)).toBe(DEFAULT_OPENROUTER_MODELS.reviewer);
  });

  it('honors explicit concurrency and role overrides', () => {
    const env = {
      MODEL_PROVIDER: 'openrouter',
      MODEL_INFERENCE_CONCURRENCY: '3',
      OPENROUTER_MODEL_BUILDER: 'custom/builder',
    };
    expect(resolveModelConcurrency(env)).toBe(3);
    expect(resolveAssignedModel('builder', env)).toBe('custom/builder');
    expect(resolveModelConcurrency({ MODEL_PROVIDER: 'ollama', MODEL_INFERENCE_CONCURRENCY: '99' })).toBe(1);
    expect(resolveInferenceRoutingPolicy('reviewer', {
      MODEL_PROVIDER: 'ollama',
      MODEL_PROVIDER_REVIEWER: 'openrouter',
    }).provider).toBe('openrouter');
  });

  it('rejects unknown providers', () => {
    expect(() => parseModelProvider('lmstudio')).toThrow(/Unsupported MODEL_PROVIDER/);
  });
});
