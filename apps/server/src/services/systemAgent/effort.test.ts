import { describe, expect, it } from 'vitest';

import { readExtendParamsFromRuntimeState } from './effort';

const runtimeState = {
  enabledAiModels: [
    {
      id: 'gpt-5.6',
      providerId: 'openai',
      settings: { extendParams: ['gpt5_6ReasoningEffort'] },
    },
    {
      id: 'gpt-5.6',
      providerId: 'lobehub',
      settings: { extendParams: [] },
    },
    {
      id: 'claude-opus-4-6',
      providerId: 'anthropic',
      settings: { extendParams: ['effort'] },
    },
  ],
};

describe('readExtendParamsFromRuntimeState', () => {
  it('matches by model id and provider id', () => {
    expect(readExtendParamsFromRuntimeState(runtimeState, 'gpt-5.6', 'openai')).toEqual([
      'gpt5_6ReasoningEffort',
    ]);
  });

  it('falls back to id-only when the provider card has empty extendParams', () => {
    expect(readExtendParamsFromRuntimeState(runtimeState, 'gpt-5.6', 'lobehub')).toEqual([
      'gpt5_6ReasoningEffort',
    ]);
  });

  it('returns undefined when the model is missing', () => {
    expect(
      readExtendParamsFromRuntimeState(runtimeState, 'unknown-model', 'openai'),
    ).toBeUndefined();
  });

  it('returns undefined when runtime state has no models', () => {
    expect(
      readExtendParamsFromRuntimeState({ enabledAiModels: [] }, 'gpt-5.6', 'openai'),
    ).toBeUndefined();
    expect(readExtendParamsFromRuntimeState(undefined, 'gpt-5.6', 'openai')).toBeUndefined();
  });
});
