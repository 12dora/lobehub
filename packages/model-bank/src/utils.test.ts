import { describe, expect, it } from 'vitest';

import {
  prefersNativeSearchByDefault,
  resolveModelSearchDefaultSettings,
  resolveSearchDecision,
  shouldExposeProviderSearchChoice,
} from './utils';

describe('resolveSearchDecision', () => {
  it.each([
    {
      expected: { application: false, model: false },
      input: { modelSearchImpl: 'internal' as const, searchMode: 'off' as const },
      name: 'disables every search route when search is off',
    },
    {
      expected: { application: false, model: true },
      input: {
        modelSearchImpl: 'params' as const,
        searchMode: 'on' as const,
        useModelBuiltinSearch: true,
      },
      name: 'uses model search when supported and selected',
    },
    {
      expected: { application: true, model: false },
      input: {
        modelSearchImpl: 'params' as const,
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'uses application search when model search is not selected',
    },
    {
      expected: { application: true, model: false },
      input: { searchMode: 'on' as const, useModelBuiltinSearch: true },
      name: 'falls back to application search when native search is unsupported',
    },
    {
      expected: { application: false, model: true },
      input: { modelSearchImpl: 'internal' as const, searchMode: 'on' as const },
      name: 'always uses internal model search while search is enabled',
    },
    {
      expected: { application: false, model: true },
      input: { providerSearchMode: 'internal' as const, searchMode: 'on' as const },
      name: 'always uses internal provider search while search is enabled',
    },
    {
      expected: { application: false, model: true },
      input: { provider: 'grok', searchMode: 'auto' as const },
      name: 'defaults Grok to native search when the builtin toggle is unset',
    },
    {
      expected: { application: false, model: true },
      input: { provider: 'supergrok', searchMode: 'on' as const },
      name: 'defaults SuperGrok to native search when the builtin toggle is unset',
    },
    {
      expected: { application: false, model: true },
      input: { provider: 'xai', searchMode: 'on' as const },
      name: 'defaults xAI to native search when the builtin toggle is unset',
    },
    {
      expected: { application: true, model: false },
      input: {
        provider: 'grok',
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'keeps application search when Grok explicitly disables model builtin search',
    },
    {
      expected: { application: false, model: true },
      input: {
        modelSearchImpl: 'params' as const,
        provider: 'grok',
        searchMode: 'on' as const,
        useModelBuiltinSearch: true,
      },
      name: 'uses native search when Grok explicitly enables model builtin search',
    },
    {
      expected: { application: false, model: true },
      input: {
        modelSearchImpl: 'params' as const,
        provider: 'openai',
        searchMode: 'on' as const,
      },
      name: 'defaults OpenAI onto native search when the toggle is unset',
    },
    {
      expected: { application: false, model: true },
      input: {
        modelSearchImpl: 'params' as const,
        provider: 'chatgpt',
        searchMode: 'auto' as const,
      },
      name: 'defaults ChatGPT onto native search when the toggle is unset',
    },
    {
      expected: { application: false, model: true },
      input: {
        provider: 'cursor',
        providerSearchMode: 'params' as const,
        searchMode: 'on' as const,
      },
      name: 'defaults Cursor onto native search from provider searchMode when the toggle is unset',
    },
    {
      expected: { application: true, model: false },
      input: {
        modelSearchImpl: 'params' as const,
        provider: 'openai',
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'keeps application search when OpenAI explicitly disables model builtin search',
    },
    {
      expected: { application: false, model: true },
      input: {
        modelSearchImpl: 'internal' as const,
        provider: 'grok',
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'keeps Grok internal model search even when App Search is requested',
    },
    {
      expected: { application: false, model: true },
      input: {
        provider: 'xai',
        providerSearchMode: 'internal' as const,
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'keeps xAI internal provider search even when App Search is requested',
    },
    {
      expected: { application: false, model: true },
      input: {
        modelSearchImpl: 'params' as const,
        provider: 'xai',
        providerSearchMode: 'internal' as const,
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'keeps xAI internal provider search even when the model has params metadata and App Search is requested',
    },
    {
      expected: { application: false, model: true },
      input: {
        modelSearchImpl: 'internal' as const,
        provider: 'perplexity',
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'keeps Perplexity internal search even when App Search is requested',
    },
    {
      expected: { application: true, model: false },
      input: {
        modelSearchImpl: 'params' as const,
        provider: 'grok',
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'lets explicit App Search override Grok params metadata',
    },
    {
      expected: { application: true, model: false },
      input: {
        modelSearchImpl: 'tool' as const,
        provider: 'grok',
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'lets explicit App Search override Grok tool metadata',
    },
  ])('$name', ({ expected, input }) => {
    const result = resolveSearchDecision(input);

    expect(result.useModelSearch).toBe(expected.model);
    expect(result.useApplicationBuiltinSearchTool).toBe(expected.application);
    expect(result.enabledSearch).toBe(input.searchMode !== 'off');
  });
});

describe('shouldExposeProviderSearchChoice', () => {
  it('exposes Provider Search for xai even without model/provider search metadata', () => {
    expect(
      shouldExposeProviderSearchChoice({
        isModelBuiltinSearchInternal: false,
        isModelHasBuiltinSearch: false,
        isProviderHasBuiltinSearch: false,
        provider: 'xai',
      }),
    ).toBe(true);
  });

  it('hides Provider Search for a custom provider with no search metadata', () => {
    expect(
      shouldExposeProviderSearchChoice({
        isModelBuiltinSearchInternal: false,
        isModelHasBuiltinSearch: false,
        isProviderHasBuiltinSearch: false,
        provider: 'openai',
      }),
    ).toBe(false);
  });

  it('hides Provider Search for true internal models that are not Grok-family', () => {
    expect(
      shouldExposeProviderSearchChoice({
        isModelBuiltinSearchInternal: true,
        isModelHasBuiltinSearch: true,
        isProviderHasBuiltinSearch: false,
        provider: 'perplexity',
      }),
    ).toBe(false);
  });

  it('hides App Search for internal Grok models even though the family defaults to native', () => {
    expect(
      shouldExposeProviderSearchChoice({
        isModelBuiltinSearchInternal: true,
        isModelHasBuiltinSearch: true,
        isProviderHasBuiltinSearch: false,
        provider: 'grok',
      }),
    ).toBe(false);
  });

  it.each(['grok', 'supergrok', 'xai'])(
    'hides App Search for %s when provider search metadata is internal and the model has none',
    (provider) => {
      expect(
        shouldExposeProviderSearchChoice({
          isModelBuiltinSearchInternal: false,
          isModelHasBuiltinSearch: false,
          isProviderBuiltinSearchInternal: true,
          isProviderHasBuiltinSearch: true,
          provider,
        }),
      ).toBe(false);
    },
  );

  it.each(['grok', 'supergrok', 'xai'])(
    'hides App Search for %s when provider search metadata is internal even if the model has params search',
    (provider) => {
      expect(
        shouldExposeProviderSearchChoice({
          isModelBuiltinSearchInternal: false,
          isModelHasBuiltinSearch: true,
          isProviderBuiltinSearchInternal: true,
          isProviderHasBuiltinSearch: true,
          provider,
        }),
      ).toBe(false);
    },
  );

  it('still exposes Provider Search for Grok-family when provider search is params', () => {
    expect(
      shouldExposeProviderSearchChoice({
        isModelBuiltinSearchInternal: false,
        isModelHasBuiltinSearch: false,
        isProviderBuiltinSearchInternal: false,
        isProviderHasBuiltinSearch: true,
        provider: 'xai',
      }),
    ).toBe(true);
  });
});

describe('prefersNativeSearchByDefault', () => {
  it.each(['grok', 'supergrok', 'xai'])('is true for %s', (provider) => {
    expect(prefersNativeSearchByDefault(provider)).toBe(true);
  });

  it.each(['openai', 'anthropic', 'google', undefined])('is false for %s', (provider) => {
    expect(prefersNativeSearchByDefault(provider)).toBe(false);
  });
});

describe('resolveModelSearchDefaultSettings', () => {
  it('keeps model-specific internal search defaults', () => {
    expect(resolveModelSearchDefaultSettings('openai', 'gpt-4o-search-preview')).toEqual({
      searchImpl: 'internal',
    });
  });

  it('falls back to params for unknown providers', () => {
    expect(resolveModelSearchDefaultSettings('custom-provider', 'remote-model')).toEqual({
      searchImpl: 'params',
    });
  });

  it.each(['grok', 'supergrok', 'xai', 'chatgpt', 'cursor'])(
    'uses params search for %s remote models',
    (provider) => {
      expect(resolveModelSearchDefaultSettings(provider, 'remote-model')).toEqual({
        searchImpl: 'params',
      });
    },
  );
});
