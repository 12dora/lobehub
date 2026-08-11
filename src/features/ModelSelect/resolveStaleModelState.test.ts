import { type LobeDefaultAiModelListItem } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { type EnabledProviderWithModels } from '@/types/aiProvider';

import { resolveEnableTargetProviderId, resolveStaleModelState } from './resolveStaleModelState';

const enabledList = [
  {
    children: [{ abilities: {}, displayName: 'Claude Opus 4.6', id: 'claude-opus-4-6' }],
    id: 'lobehub',
    name: 'LobeHub',
    source: 'builtin',
  },
] as unknown as EnabledProviderWithModels[];

const builtinAiModelList = [
  {
    abilities: {},
    displayName: 'GPT-5.4 nano',
    enabled: false,
    id: 'gpt-5.4-nano',
    providerId: 'lobehub',
    type: 'chat',
  },
] as unknown as LobeDefaultAiModelListItem[];

const context = { builtinAiModelList, enabledList, modelType: 'chat' as const };

describe('resolveStaleModelState', () => {
  it('returns undefined for a value present in the enabled list', () => {
    expect(
      resolveStaleModelState({ model: 'claude-opus-4-6', provider: 'lobehub' }, context),
    ).toBeUndefined();
  });

  it('returns undefined when there is no value', () => {
    expect(resolveStaleModelState(undefined, context)).toBeUndefined();
  });

  it('resolves a disabled builtin model as notEnabled with its metadata', () => {
    const state = resolveStaleModelState({ model: 'gpt-5.4-nano', provider: 'lobehub' }, context);

    expect(state?.status).toBe('notEnabled');
    expect(state?.meta?.displayName).toBe('GPT-5.4 nano');
  });

  it('falls back to an id-only match when the provider does not match', () => {
    const state = resolveStaleModelState({ model: 'gpt-5.4-nano', provider: 'openai' }, context);

    expect(state?.status).toBe('notEnabled');
    expect(state?.meta?.displayName).toBe('GPT-5.4 nano');
  });

  it('resolves an unknown model id as removed', () => {
    const state = resolveStaleModelState({ model: 'gpt-4o-mini', provider: 'openai' }, context);

    expect(state?.status).toBe('removed');
    expect(state?.meta).toBeUndefined();
  });

  it('does not treat a same-id model under another enabled provider as enabled', () => {
    const state = resolveStaleModelState(
      { model: 'claude-opus-4-6', provider: 'bedrock' },
      context,
    );

    expect(state?.status).toBe('removed');
  });

  it('ignores builtin models of a different type', () => {
    const state = resolveStaleModelState(
      { model: 'gpt-5.4-nano', provider: 'lobehub' },
      { ...context, modelType: 'embedding' },
    );

    expect(state?.status).toBe('removed');
  });

  describe('resolveEnableTargetProviderId', () => {
    it('prefers the persisted provider when it has enabled models of this type', () => {
      expect(
        resolveEnableTargetProviderId(
          { model: 'gpt-5.4-nano', provider: 'lobehub' },
          { enabledList, metaProviderId: 'openai' },
        ),
      ).toBe('lobehub');
    });

    it('prefers the persisted provider when it is enabled without models of this type', () => {
      expect(
        resolveEnableTargetProviderId(
          { model: 'gpt-5.4-nano', provider: 'lobehub' },
          {
            enabledAiProviders: [{ id: 'lobehub' }],
            enabledList: [],
            metaProviderId: 'openai',
          },
        ),
      ).toBe('lobehub');
    });

    it('falls back to the builtin provider when the persisted provider is unknown', () => {
      expect(
        resolveEnableTargetProviderId(
          { model: 'gpt-5.4-nano', provider: 'legacy-provider' },
          { enabledAiProviders: [{ id: 'lobehub' }], enabledList, metaProviderId: 'openai' },
        ),
      ).toBe('openai');
    });

    it('falls back to the builtin provider when the value has no provider', () => {
      expect(
        resolveEnableTargetProviderId(
          { model: 'gpt-5.4-nano' },
          { enabledList, metaProviderId: 'openai' },
        ),
      ).toBe('openai');
    });
  });
});
