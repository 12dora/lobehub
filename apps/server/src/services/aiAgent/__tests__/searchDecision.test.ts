import { describe, expect, it } from 'vitest';

import { resolveServerSearchDecision } from '../searchDecision';

describe('resolveServerSearchDecision', () => {
  it('uses managed metadata to disable native search and fall back to application search', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [
        {
          abilities: { search: true },
          id: 'gpt-4o-search-preview',
          providerId: 'openai',
          settings: { searchImpl: 'internal' },
        },
      ],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      isManagedModel: true,
      model: 'gpt-4o-search-preview',
      modelSearchAbility: false,
      provider: 'openai',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
  });

  it('fails closed when managed search metadata is missing', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [
        {
          abilities: { search: true },
          id: 'gpt-4o-search-preview',
          providerId: 'openai',
          settings: { searchImpl: 'internal' },
        },
      ],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      isManagedModel: true,
      model: 'gpt-4o-search-preview',
      provider: 'openai',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
  });

  it('allows native search when the managed revision explicitly enables it', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      isManagedModel: true,
      model: 'managed-search-model',
      modelSearchAbility: true,
      modelSearchImpl: 'internal',
      provider: 'managed-provider',
    });

    expect(result.useModelSearch).toBe(true);
    expect(result.useApplicationBuiltinSearchTool).toBe(false);
  });

  it('keeps builtin fallback behavior for an unmanaged model', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [
        {
          abilities: { search: true },
          id: 'personal-model',
          providerId: 'personal-provider',
          settings: { searchImpl: 'internal' },
        },
      ],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      model: 'personal-model',
      provider: 'personal-provider',
    });

    expect(result.useModelSearch).toBe(true);
    expect(result.useApplicationBuiltinSearchTool).toBe(false);
  });

  it('does not borrow native search capability from another provider with the same model id', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [
        {
          abilities: { search: true },
          id: 'grok-4.3',
          providerId: 'xai',
          settings: { searchImpl: 'params' },
        },
      ],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      model: 'grok-4.3',
      provider: 'custom-openai-compatible',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
  });

  it('honors a stored abilities override that omits builtin search', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [
        {
          abilities: { search: true },
          id: 'remote-model',
          providerId: 'custom-provider',
        },
      ],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      hasModelAbilitiesOverride: true,
      model: 'remote-model',
      provider: 'custom-provider',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
  });

  it.each(['supergrok', 'openrouter'])(
    'uses %s provider search for an unlisted model',
    (provider) => {
      const result = resolveServerSearchDecision({
        builtinModels: [],
        chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
        model: 'new-remote-model',
        provider,
      });

      expect(result.isProviderHasBuiltinSearch).toBe(true);
      expect(result.useModelSearch).toBe(true);
      expect(result.useApplicationBuiltinSearchTool).toBe(false);
    },
  );

  it('uses explicit params search even when abilities.search is absent', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      model: 'remote-model',
      modelSearchImpl: 'params',
      provider: 'custom-provider',
    });

    expect(result.useModelSearch).toBe(true);
    expect(result.useApplicationBuiltinSearchTool).toBe(false);
  });

  it('infers internal search for a remotely discovered model', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'on' },
      model: 'jina-deepsearch-v1',
      modelSearchAbility: true,
      provider: 'jina',
    });

    expect(result.useModelSearch).toBe(true);
    expect(result.useApplicationBuiltinSearchTool).toBe(false);
  });

  it('disables both routes when search mode is off', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'off', useModelBuiltinSearch: true },
      model: 'remote-model',
      modelSearchImpl: 'internal',
      provider: 'custom-provider',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(false);
  });

  it.each(['grok', 'supergrok', 'xai'])(
    'defaults %s to native search when the builtin toggle is unset',
    (provider) => {
      const result = resolveServerSearchDecision({
        builtinModels: [],
        chatConfig: { searchMode: 'auto' },
        model: 'grok-4.6',
        provider,
      });

      expect(result.useModelSearch).toBe(true);
      expect(result.useApplicationBuiltinSearchTool).toBe(false);
    },
  );

  it('uses application search for grok when useModelBuiltinSearch is explicitly false', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: false },
      model: 'grok-4.6',
      provider: 'grok',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
  });

  it('falls back to application search when selected native search is unsupported', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      model: 'remote-model',
      provider: 'custom-provider',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
  });
});
