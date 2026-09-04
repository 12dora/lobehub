import { DEFAULT_INBOX_AVATAR } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import { resolveDefaultInboxAvatar } from './useDefaultInboxAvatar';

const NO_BRAND = { iconUrl: null, logoUrl: null, publishedRevision: null };
const PUBLISHED_BRAND = {
  iconUrl: 'https://brand.example.com/icon.png',
  logoUrl: 'https://brand.example.com/logo.png',
  publishedRevision: '7',
};

describe('resolveDefaultInboxAvatar', () => {
  it('keeps the product default when no brand is published', () => {
    expect(resolveDefaultInboxAvatar(NO_BRAND)).toBe(DEFAULT_INBOX_AVATAR);
    expect(resolveDefaultInboxAvatar(NO_BRAND, '/avatars/lobe-ai.png')).toBe(DEFAULT_INBOX_AVATAR);
    expect(resolveDefaultInboxAvatar({ ...PUBLISHED_BRAND, publishedRevision: null }, '')).toBe(
      DEFAULT_INBOX_AVATAR,
    );
  });

  it('replaces the builtin avatar with the published brand icon', () => {
    expect(resolveDefaultInboxAvatar(PUBLISHED_BRAND)).toBe(PUBLISHED_BRAND.iconUrl);
    expect(resolveDefaultInboxAvatar(PUBLISHED_BRAND, '/avatars/lobe-ai.png')).toBe(
      PUBLISHED_BRAND.iconUrl,
    );
    expect(resolveDefaultInboxAvatar(PUBLISHED_BRAND, DEFAULT_INBOX_AVATAR)).toBe(
      PUBLISHED_BRAND.iconUrl,
    );
    expect(resolveDefaultInboxAvatar(PUBLISHED_BRAND, '   ')).toBe(PUBLISHED_BRAND.iconUrl);
  });

  it('falls back to the published logo, then to the product default', () => {
    expect(resolveDefaultInboxAvatar({ ...PUBLISHED_BRAND, iconUrl: null })).toBe(
      PUBLISHED_BRAND.logoUrl,
    );
    expect(resolveDefaultInboxAvatar({ ...PUBLISHED_BRAND, iconUrl: '  ' })).toBe(
      PUBLISHED_BRAND.logoUrl,
    );
    expect(
      resolveDefaultInboxAvatar({ iconUrl: null, logoUrl: null, publishedRevision: '7' }),
    ).toBe(DEFAULT_INBOX_AVATAR);
  });

  it('never overrides a customised inbox avatar', () => {
    expect(resolveDefaultInboxAvatar(PUBLISHED_BRAND, '🤖')).toBe('🤖');
    expect(resolveDefaultInboxAvatar(PUBLISHED_BRAND, 'https://cdn.example.com/me.png')).toBe(
      'https://cdn.example.com/me.png',
    );
    expect(resolveDefaultInboxAvatar(NO_BRAND, '🤖')).toBe('🤖');
  });
});
