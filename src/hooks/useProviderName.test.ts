import { renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProviderDisplayName, useProviderDisplayName } from './useProviderName';

const mocks = vi.hoisted(() => ({
  /** Rows of the scoped aiInfra store — where a CUSTOM provider's name lives. */
  aiProviderList: [] as { id: string; name?: string }[],
  /** Every id the hook handed to the store selector; `undefined` means "skipped the scan". */
  selectorArgs: [] as (string | undefined)[],
}));

vi.mock('@/store/aiInfra', async () => {
  // The REAL selector, wrapped only to record what the hook asks it for.
  const { aiProviderSelectors } = await import('@/store/aiInfra/slices/aiProvider/selectors');

  return {
    aiProviderSelectors: {
      ...aiProviderSelectors,
      providerNameById: (id?: string) => {
        mocks.selectorArgs.push(id);
        return aiProviderSelectors.providerNameById(id);
      },
    },
    useScopedAiInfraStore: (selector: (state: unknown) => unknown) =>
      selector({ aiProviderList: mocks.aiProviderList }),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      key === 'chatgptweb.name' ? 'ChatGPT 网页版' : (options?.defaultValue ?? key),
  }),
}));

/**
 * Stand-in for a `providers`-bound `t`: resolves only the keys the namespace actually ships,
 * and falls back to `defaultValue` for everything else — exactly like i18next.
 */
const translate = (dictionary: Record<string, string>) =>
  ((key: string, options?: { defaultValue?: string }) =>
    dictionary[key] ?? options?.defaultValue ?? key) as unknown as TFunction<'providers'>;

const withChatGPTWeb = translate({ 'chatgptweb.name': 'ChatGPT 网页版' });
const empty = translate({});

describe('getProviderDisplayName', () => {
  it('uses the localized name for the providers that opt in', () => {
    expect(getProviderDisplayName('chatgptweb', withChatGPTWeb)).toBe('ChatGPT 网页版');
  });

  it('keeps the model-bank card name for providers without a name key', () => {
    // Brand names must NOT be translated — the namespace deliberately ships no key for these.
    expect(getProviderDisplayName('anthropic', withChatGPTWeb)).toBe('Anthropic');
    expect(getProviderDisplayName('chatgptweb', empty)).toBe('ChatGPT Web');
  });

  it('prefers a caller-supplied name, so custom providers pass through untouched', () => {
    expect(getProviderDisplayName('my-proxy', withChatGPTWeb, 'My Proxy')).toBe('My Proxy');
  });

  it('still localizes a builtin id when the caller passes the card name as fallback', () => {
    expect(getProviderDisplayName('chatgptweb', withChatGPTWeb, 'ChatGPT Web')).toBe(
      'ChatGPT 网页版',
    );
  });

  it('echoes the raw id for an unknown provider', () => {
    expect(getProviderDisplayName('nope', empty)).toBe('nope');
  });

  it('returns nothing when there is nothing to name', () => {
    // Callers (OAuthExpiredError) read an empty result as "name it generically instead".
    expect(getProviderDisplayName('', empty)).toBe('');
  });
});

describe('useProviderDisplayName', () => {
  beforeEach(() => {
    mocks.aiProviderList = [
      { id: 'internal_proxy', name: 'Internal Gateway' },
      { id: 'unnamed_proxy' },
      // A stale row must never shadow the card of a builtin.
      { id: 'anthropic', name: 'stale row' },
    ];
    mocks.selectorArgs = [];
  });

  it('names a builtin from its card, without scanning the store for it', () => {
    const { result } = renderHook(() => useProviderDisplayName('anthropic'));

    expect(result.current).toBe('Anthropic');
    // The LOW finding: a builtin subscribing every render to a linear list scan whose answer
    // is thrown away. `undefined` is what makes the selector a no-op.
    expect(mocks.selectorArgs).toEqual([undefined]);
  });

  it('localizes the builtins whose name the namespace opts in', () => {
    const { result } = renderHook(() => useProviderDisplayName('chatgptweb'));

    expect(result.current).toBe('ChatGPT 网页版');
  });

  it('uses the stored name of a custom provider instead of its raw id', () => {
    const { result } = renderHook(() => useProviderDisplayName('internal_proxy'));

    expect(result.current).toBe('Internal Gateway');
    expect(mocks.selectorArgs).toEqual(['internal_proxy']);
  });

  it('returns nothing rather than an id nobody recognises', () => {
    // A custom provider whose row has no name, and one the store has not loaded at all:
    // callers read `undefined` as "render no provider name", never as "print the id".
    expect(
      renderHook(() => useProviderDisplayName('unnamed_proxy')).result.current,
    ).toBeUndefined();
    expect(renderHook(() => useProviderDisplayName('not_loaded')).result.current).toBeUndefined();
    expect(renderHook(() => useProviderDisplayName(undefined)).result.current).toBeUndefined();
  });
});
