// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import type { LobeChatDatabase } from '@/database/type';
import {
  DEFAULT_PLATFORM_AUTH_SETTINGS,
  type PlatformAuthSettings,
} from '@/types/platform/authSettings';
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
  themeDefaults: { primaryColor: '#E4002B' },
};

const authSettings =
  (patch: Partial<PlatformAuthSettings> = {}) =>
  async (): Promise<PlatformAuthSettings> => ({ ...DEFAULT_PLATFORM_AUTH_SETTINGS, ...patch });

describe('resolvePlatformPublicSnapshot', () => {
  it('reads auth settings (but no branding) while Runtime Branding is disabled', async () => {
    // The login/registration projection is always read so the anonymous login page can hide
    // the sign-up link even when branding is off — only branding itself is flag-gated.
    const getDatabase = vi.fn(async () => ({}) as LobeChatDatabase);
    const getPublishedBranding = vi.fn();

    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS },
      getAuthSettings: authSettings({ openRegistration: false }),
      getDatabase,
      getPublishedBranding,
    });

    expect(getDatabase).toHaveBeenCalled();
    expect(getPublishedBranding).not.toHaveBeenCalled();
    expect(snapshot.branding).toBeNull();
    expect(snapshot.login.openRegistration).toBe(false);
  });

  it('returns the unique strict Published branding when the flag is enabled', async () => {
    const database = {} as LobeChatDatabase;
    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getAuthSettings: authSettings(),
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
    expect(snapshot.login.openRegistration).toBe(true);
  });

  it('keeps the disabled revision contract when no Published branding exists', async () => {
    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getAuthSettings: authSettings(),
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

  it.each(['duplicate Published rows', 'invalid URL'])(
    'drops branding only for %s while preserving auth settings',
    async (message) => {
      const snapshot = await resolvePlatformPublicSnapshot({
        flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
        getAuthSettings: authSettings({ openRegistration: false }),
        getDatabase: async () => ({}) as LobeChatDatabase,
        getPublishedBranding: async () => {
          throw new Error(message);
        },
      });

      expect(snapshot.branding).toBeNull();
      expect(snapshot.brandingRevision).toBeNull();
      expect(snapshot.configRevision).toBe('0');
      expect(snapshot.platformName).toBeNull();
      // Branding failure must not open registration when platform policy closed it.
      expect(snapshot.login.openRegistration).toBe(false);
    },
  );

  it('branding failure + openRegistration=false remains false', async () => {
    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getAuthSettings: authSettings({ openRegistration: false }),
      getDatabase: async () => ({}) as LobeChatDatabase,
      getPublishedBranding: async () => {
        throw new Error('branding store unavailable');
      },
    });

    expect(snapshot.branding).toBeNull();
    expect(snapshot.login.openRegistration).toBe(false);
  });

  it('fails closed to the built-in snapshot when auth settings are unavailable', async () => {
    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getAuthSettings: async () => {
        throw new Error('auth settings unavailable');
      },
      getDatabase: async () => ({}) as LobeChatDatabase,
      getPublishedBranding: async () => publishedBranding,
    });

    // Branding still resolves when only auth fails.
    expect(snapshot.branding).toEqual(publishedBranding);
    expect(snapshot.login.openRegistration).toBe(true);
  });

  it('fails closed entirely when the database is unavailable', async () => {
    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_RUNTIME_BRANDING: true },
      getAuthSettings: authSettings({ openRegistration: false }),
      getDatabase: async () => {
        throw new Error('database unavailable');
      },
      getPublishedBranding: async () => publishedBranding,
    });

    expect(snapshot.branding).toBeNull();
    expect(snapshot.login.openRegistration).toBe(true);
    expect(snapshot.login.workAccountEnabled).toBe(false);
  });

  it('keeps workAccountEnabled false when database OIDC is disabled', async () => {
    const getPublishedIdentityTarget = vi.fn(async () => ({
      environmentShadowed: [],
      identityRevision: 'rev',
      providers: [{ providerId: 'work' }],
    }));

    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_DATABASE_OIDC: false },
      getAuthSettings: authSettings(),
      getDatabase: async () => ({}) as LobeChatDatabase,
      getPublishedIdentityTarget: getPublishedIdentityTarget as never,
    });

    expect(getPublishedIdentityTarget).not.toHaveBeenCalled();
    expect(snapshot.login.workAccountEnabled).toBe(false);
  });

  it('reports workAccountEnabled false when no published IdP exists', async () => {
    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_DATABASE_OIDC: true },
      getAuthSettings: authSettings(),
      getDatabase: async () => ({}) as LobeChatDatabase,
      getPublishedIdentityTarget: async () =>
        ({
          environmentShadowed: [],
          identityRevision: 'empty',
          providers: [],
        }) as never,
    });

    expect(snapshot.login.workAccountEnabled).toBe(false);
  });

  it('reports workAccountEnabled true when a published IdP exists', async () => {
    const database = {} as LobeChatDatabase;
    const getPublishedIdentityTarget = vi.fn(async (db: LobeChatDatabase) => {
      expect(db).toBe(database);
      return {
        environmentShadowed: [],
        identityRevision: 'rev-1',
        providers: [{ providerId: 'work', providerKey: 'oidc' }],
      };
    });

    const snapshot = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_DATABASE_OIDC: true },
      getAuthSettings: authSettings(),
      getDatabase: async () => database,
      getPublishedIdentityTarget: getPublishedIdentityTarget as never,
    });

    expect(getPublishedIdentityTarget).toHaveBeenCalledOnce();
    expect(snapshot.login.workAccountEnabled).toBe(true);
  });

  it('still reports workAccountEnabled when providers are environment-shadowed metadata only', async () => {
    // environmentShadowed is metadata about env collision; presence of published providers
    // still enables the work-account button. Empty providers (fully shadowed away) stays false.
    const withProviders = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_DATABASE_OIDC: true },
      getAuthSettings: authSettings(),
      getDatabase: async () => ({}) as LobeChatDatabase,
      getPublishedIdentityTarget: async () =>
        ({
          environmentShadowed: ['work'],
          identityRevision: 'rev',
          providers: [{ providerId: 'work' }],
        }) as never,
    });
    expect(withProviders.login.workAccountEnabled).toBe(true);

    const shadowedAway = await resolvePlatformPublicSnapshot({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_DATABASE_OIDC: true },
      getAuthSettings: authSettings(),
      getDatabase: async () => ({}) as LobeChatDatabase,
      getPublishedIdentityTarget: async () =>
        ({
          environmentShadowed: ['work'],
          identityRevision: 'empty',
          providers: [],
        }) as never,
    });
    expect(shadowedAway.login.workAccountEnabled).toBe(false);
  });

  it('fails closed to workAccountEnabled false when the identity loader throws', async () => {
    const snapshot = await resolvePlatformPublicSnapshot({
      flags: {
        ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
        ENABLE_DATABASE_OIDC: true,
        ENABLE_RUNTIME_BRANDING: true,
      },
      getAuthSettings: authSettings({ openRegistration: false }),
      getDatabase: async () => ({}) as LobeChatDatabase,
      getPublishedBranding: async () => publishedBranding,
      getPublishedIdentityTarget: async () => {
        throw new Error('identity store unavailable');
      },
    });

    expect(snapshot.branding).toEqual(publishedBranding);
    expect(snapshot.login.openRegistration).toBe(false);
    expect(snapshot.login.workAccountEnabled).toBe(false);
  });
});
