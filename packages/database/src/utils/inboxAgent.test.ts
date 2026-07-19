import { DEFAULT_INBOX_TITLE, INBOX_SESSION_ID } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import { normalizeInboxAgentTitle } from './inboxAgent';

describe('normalizeInboxAgentTitle', () => {
  it('uses an injected runtime fallback only for a blank inbox title', () => {
    expect(normalizeInboxAgentTitle(null, { slug: INBOX_SESSION_ID }, 'AIHub AI')).toBe('AIHub AI');
    expect(normalizeInboxAgentTitle(null, { slug: 'page-agent' }, 'AIHub AI')).toBeNull();
  });

  it('never guesses whether an explicit legacy literal is user-authored', () => {
    expect(normalizeInboxAgentTitle('Lobe AI', { slug: INBOX_SESSION_ID }, 'AIHub AI')).toBe(
      'Lobe AI',
    );
  });

  it('keeps the immutable fallback as the default and for invalid injected values', () => {
    expect(normalizeInboxAgentTitle(null, { slug: INBOX_SESSION_ID })).toBe(DEFAULT_INBOX_TITLE);
    expect(normalizeInboxAgentTitle(null, { slug: INBOX_SESSION_ID }, '  ')).toBe(
      DEFAULT_INBOX_TITLE,
    );
  });

  it('can defer fallback until an owning service resolves branding', () => {
    expect(normalizeInboxAgentTitle(null, { slug: INBOX_SESSION_ID }, null)).toBeNull();
  });
});
