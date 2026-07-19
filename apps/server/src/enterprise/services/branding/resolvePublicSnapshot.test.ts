// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import type { LobeChatDatabase } from '@/database/type';
import type { PlatformBrandingPublished } from '@/types/platform/branding';

import { resolvePlatformPublicSnapshot } from './resolvePublicSnapshot';

const publishedBranding: PlatformBrandingPublished = {
  defaultAgentDisplayName: null,
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: '/logo.png',
  name: 'AIHub',
  ogImageUrl: null,
  pageTitleTemplate: null,
  privacyUrl: null,
  revision: '5',
  shortName: null,
  supportUrl: null,
  termsUrl: null,
};

describe('resolvePlatformPublicSnapshot', () => {
  it('performs zero database work while Runtime Branding is disabled', async () => {
    const getDatabase = vi.fn<() => Promise<LobeChatDatabase>>();
    const getPublishedBranding = vi.fn();

    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS },
      getDatabase,
      getPublishedBranding,
    });

    expect(getDatabase).not.toHaveBeenCalled();
    expect(getPublishedBranding).not.toHaveBeenCalled();
    expect(snapshot.branding).toBeNull();
  });

  it('returns the unique strict Published branding when the flag is enabled', async () => {
    const database = {} as LobeChatDatabase;
    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getDatabase: async () => database,
      getPublishedBranding: async (db) => {
        expect(db).toBe(database);
        return publishedBranding;
      },
    });

    expect(snapshot).toMatchObject({
      branding: publishedBranding,
      brandingRevision: '5',
      configRevision: '5',
      logoUrl: '/logo.png',
      platformName: 'AIHub',
    });
  });

  it('keeps the disabled revision contract when no Published branding exists', async () => {
    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getDatabase: async () => ({}) as LobeChatDatabase,
      getPublishedBranding: async () => null,
    });

    expect(snapshot).toMatchObject({
      branding: null,
      brandingRevision: null,
      configRevision: '0',
      logoUrl: null,
      platformName: null,
    });
  });

  it.each(['database unavailable', 'duplicate Published rows', 'invalid URL'])(
    'fails closed to the built-in snapshot for %s',
    async (message) => {
      const snapshot = await resolvePlatformPublicSnapshot({
        flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
        getDatabase: async () => ({}) as LobeChatDatabase,
        getPublishedBranding: async () => {
          throw new Error(message);
        },
      });

      expect(snapshot.branding).toBeNull();
      expect(snapshot.brandingRevision).toBeNull();
      expect(snapshot.configRevision).toBe('0');
      expect(snapshot.platformName).toBeNull();
    },
  );
});
