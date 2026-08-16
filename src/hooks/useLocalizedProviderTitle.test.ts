import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { getLocalizedProviderTitle } from './useLocalizedProviderTitle';

/**
 * Stand-in for a `providers`-bound `t`: resolves only the keys the namespace actually ships,
 * and falls back to `defaultValue` for everything else — exactly like i18next.
 */
const translate = (dictionary: Record<string, string>) =>
  ((key: string, options?: { defaultValue?: string }) =>
    dictionary[key] ?? options?.defaultValue ?? key) as unknown as TFunction<'providers'>;

const zhCN = translate({ 'chatgptweb.name': 'ChatGPT 网页版' });
const enUS = translate({ 'chatgptweb.name': 'ChatGPT Web' });
const empty = translate({});

describe('getLocalizedProviderTitle', () => {
  it('renders text once the namespace names the provider differently from the card', () => {
    expect(getLocalizedProviderTitle('chatgptweb', zhCN, 'ChatGPT Web')).toBe('ChatGPT 网页版');
  });

  it('keeps the wordmark where the localized name only repeats the card name', () => {
    // en-US ships the key with the same value: swapping the wordmark for identical text
    // would be a pure regression in every English deployment.
    expect(getLocalizedProviderTitle('chatgptweb', enUS, 'ChatGPT Web')).toBeNull();
  });

  it('keeps the wordmark for the brand names the namespace deliberately does not ship', () => {
    expect(getLocalizedProviderTitle('anthropic', zhCN, 'Anthropic')).toBeNull();
    expect(getLocalizedProviderTitle('openai', empty, 'OpenAI')).toBeNull();
  });

  it('keeps the wordmark in locales that have not been filled in yet', () => {
    // The key is missing, so i18next answers with the empty defaultValue — never the raw key.
    expect(getLocalizedProviderTitle('chatgptweb', empty, 'ChatGPT Web')).toBeNull();
  });

  it('renders text when the caller knows no card name to compare against', () => {
    expect(getLocalizedProviderTitle('chatgptweb', zhCN)).toBe('ChatGPT 网页版');
  });
});
