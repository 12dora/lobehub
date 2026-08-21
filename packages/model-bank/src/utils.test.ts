import { describe, expect, it } from 'vitest';

import {
  prefersNativeSearchByDefault,
  resolveModelSearchDefaultSettings,
  resolveSearchDecision,
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
  ])('$name', ({ expected, input }) => {
    const result = resolveSearchDecision(input);

    expect(result.useModelSearch).toBe(expected.model);
    expect(result.useApplicationBuiltinSearchTool).toBe(expected.application);
    expect(result.enabledSearch).toBe(input.searchMode !== 'off');
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
