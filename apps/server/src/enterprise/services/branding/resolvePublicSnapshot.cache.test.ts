// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { DEFAULT_PLATFORM_AUTH_SETTINGS } from '@/types/platform/authSettings';

import {
  invalidatePlatformPublicSnapshot,
  resetPlatformPublicSnapshotForTest,
  resolvePlatformPublicSnapshot,
} from './resolvePublicSnapshot';

const getAuthSettings = vi.hoisted(() =>
  vi.fn(async () => ({ ...DEFAULT_PLATFORM_AUTH_SETTINGS, openRegistration: false })),
);
const getPublished = vi.hoisted(() => vi.fn(async () => null));
const getScopeVersion = vi.hoisted(() => vi.fn(async () => '1'));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => ({})),
}));

vi.mock('@/database/models/platform', () => ({
  PlatformAuthSettingsModel: class {
    get = getAuthSettings;
  },
}));

vi.mock('./publishedReadService', () => ({
  BrandingPublishedReadService: class {
    getPublished = getPublished;
  },
}));

vi.mock('../identityProvider/systemService', () => ({
  loadPublishedIdentityTarget: vi.fn(async () => ({ providers: [] })),
}));

vi.mock('../platformConfigInvalidation', () => ({
  getPlatformConfigScopeVersion: getScopeVersion,
}));

describe('platform public snapshot process cache', () => {
  beforeEach(() => {
    resetPlatformPublicSnapshotForTest();
    getAuthSettings.mockClear();
    getPublished.mockClear();
    getScopeVersion.mockClear();
    getScopeVersion.mockResolvedValue('1');
    getAuthSettings.mockResolvedValue({
      ...DEFAULT_PLATFORM_AUTH_SETTINGS,
      openRegistration: false,
    });
  });

  afterEach(() => {
    resetPlatformPublicSnapshotForTest();
  });

  it('returns the same login projection twice and hits auth settings once', async () => {
    const flags = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS };
    const first = await resolvePlatformPublicSnapshot({ flags });
    const second = await resolvePlatformPublicSnapshot({ flags });

    expect(second).toEqual(first);
    expect(first.login.openRegistration).toBe(false);
    expect(getAuthSettings).toHaveBeenCalledTimes(1);
  });

  it('reloads after branding/auth-settings invalidation', async () => {
    const flags = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS };
    await resolvePlatformPublicSnapshot({ flags });
    invalidatePlatformPublicSnapshot();
    getAuthSettings.mockResolvedValue({
      ...DEFAULT_PLATFORM_AUTH_SETTINGS,
      openRegistration: true,
    });

    const next = await resolvePlatformPublicSnapshot({ flags });
    expect(next.login.openRegistration).toBe(true);
    expect(getAuthSettings).toHaveBeenCalledTimes(2);
  });
});
