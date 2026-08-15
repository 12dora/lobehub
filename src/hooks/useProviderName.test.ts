import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { getProviderDisplayName } from './useProviderName';

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
