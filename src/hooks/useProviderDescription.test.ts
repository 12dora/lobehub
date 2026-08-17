import { renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProviderDescription, useProviderDescription } from './useProviderDescription';

const mocks = vi.hoisted(() => ({
  /** Rows of the scoped aiInfra store — where a CUSTOM provider's description lives. */
  aiProviderList: [] as { description?: string; id: string }[],
  /** Every id the hook handed to the store selector; `undefined` means "skipped the scan". */
  selectorArgs: [] as (string | undefined)[],
}));

vi.mock('@/store/aiInfra', async () => {
  // The REAL selector, wrapped only to record what the hook asks it for.
  const { aiProviderSelectors } = await import('@/store/aiInfra/slices/aiProvider/selectors');

  return {
    aiProviderSelectors: {
      ...aiProviderSelectors,
      providerDescriptionById: (id?: string) => {
        mocks.selectorArgs.push(id);
        return aiProviderSelectors.providerDescriptionById(id);
      },
    },
    useScopedAiInfraStore: (selector: (state: unknown) => unknown) =>
      selector({ aiProviderList: mocks.aiProviderList }),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

/**
 * Stand-in for a `providers`-bound `t`: resolves only the keys the namespace actually ships,
 * and falls back to `defaultValue` for everything else — exactly like i18next.
 */
const translate = (dictionary: Record<string, string>) =>
  ((key: string, options?: { defaultValue?: string }) =>
    dictionary[key] ?? options?.defaultValue ?? key) as unknown as TFunction<'providers'>;

const localized = translate({ 'anthropic.description': 'Anthropic 的模型主打推理与安全' });
const empty = translate({});

describe('getProviderDescription', () => {
  it('uses the localized description when the namespace has one', () => {
    expect(getProviderDescription('anthropic', localized)).toBe('Anthropic 的模型主打推理与安全');
  });

  it('falls back to the model-bank card description', () => {
    const fromCard = getProviderDescription('anthropic', empty);

    expect(fromCard).toBeTruthy();
    expect(fromCard).not.toBe('anthropic.description');
  });

  it('uses the stored description for a custom provider the model-bank does not know', () => {
    // User-authored copy: it must reach the UI verbatim, never through i18n.
    expect(getProviderDescription('my-proxy', localized, 'Our in-house gateway')).toBe(
      'Our in-house gateway',
    );
  });

  it('prefers the builtin card over a stored description, so a stale row cannot shadow it', () => {
    expect(getProviderDescription('anthropic', localized, 'stale row')).toBe(
      'Anthropic 的模型主打推理与安全',
    );
  });

  it('returns nothing when there is no description anywhere', () => {
    // Callers read `undefined` as "render no description affordance at all".
    expect(getProviderDescription('my-proxy', empty)).toBeUndefined();
    expect(getProviderDescription('my-proxy', empty, '   ')).toBeUndefined();
    expect(getProviderDescription('my-proxy', empty, null)).toBeUndefined();
  });

  it('returns nothing without a provider, instead of asking i18next for an empty key', () => {
    expect(getProviderDescription(undefined, empty)).toBeUndefined();
    expect(getProviderDescription('', empty)).toBeUndefined();
  });
});

describe('useProviderDescription', () => {
  beforeEach(() => {
    mocks.aiProviderList = [
      { description: 'Our in-house gateway', id: 'internal_proxy' },
      // A stale row must never shadow the card of a builtin.
      { description: 'stale row', id: 'anthropic' },
    ];
    mocks.selectorArgs = [];
  });

  it('describes a builtin from its card, without scanning the store for it', () => {
    const { result } = renderHook(() => useProviderDescription('anthropic'));

    expect(result.current).toBeTruthy();
    expect(result.current).not.toBe('stale row');
    // The LOW finding: every group header of the longest picker subscribed to a linear list
    // scan whose answer was thrown away. `undefined` is what makes the selector a no-op.
    expect(mocks.selectorArgs).toEqual([undefined]);
  });

  it('falls back to the stored description of a custom provider', () => {
    const { result } = renderHook(() => useProviderDescription('internal_proxy'));

    expect(result.current).toBe('Our in-house gateway');
    expect(mocks.selectorArgs).toEqual(['internal_proxy']);
  });
});
