import debug from 'debug';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformAuthSettingsModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { PlatformAuthSettings } from '@/types/platform/authSettings';
import type { PlatformBrandingPublished } from '@/types/platform/branding';

import { loadPublishedIdentityTarget } from '../identityProvider/systemService';
import { getPlatformConfigScopeVersion } from '../platformConfigInvalidation';
import { buildPlatformPublicSnapshot } from '../platformPublicSnapshot';
import {
  getPlatformPublicSnapshotEpoch,
  onPlatformPublicSnapshotInvalidate,
  resetPlatformPublicSnapshotEpochForTest,
} from './publicSnapshotCache';
import { BrandingPublishedReadService } from './publishedReadService';

const log = debug('lobe-server:platform-public-snapshot');

export type PublishedIdentityTarget = Awaited<ReturnType<typeof loadPublishedIdentityTarget>>;

export interface ResolvePlatformPublicSnapshotOptions {
  flags: EnterpriseFeatureFlags;
  getAuthSettings?: (db: LobeChatDatabase) => Promise<PlatformAuthSettings>;
  getDatabase?: () => Promise<LobeChatDatabase>;
  getPublishedBranding?: (db: LobeChatDatabase) => Promise<PlatformBrandingPublished | null>;
  /**
   * Published work-account IdP loader (M11). Defaults to `loadPublishedIdentityTarget`.
   * Failures fail closed to `workAccountEnabled: false`.
   */
  getPublishedIdentityTarget?: (db: LobeChatDatabase) => Promise<PublishedIdentityTarget>;
}

const PUBLIC_SNAPSHOT_TTL_MS = 8000;
const PUBLIC_SNAPSHOT_EPOCH_SCOPES = ['branding', 'auth_settings'] as const;

type PublicSnapshot = ReturnType<typeof buildPlatformPublicSnapshot>;

interface PublicSnapshotSlot {
  expiresAt: number;
  key: string;
  value: PublicSnapshot;
}

let publicSnapshotSlot: PublicSnapshotSlot | null = null;
let publicSnapshotInflight: { key: string; promise: Promise<PublicSnapshot> } | null = null;

onPlatformPublicSnapshotInvalidate(() => {
  publicSnapshotSlot = null;
  publicSnapshotInflight = null;
});

const usesDefaultLoaders = (options: ResolvePlatformPublicSnapshotOptions): boolean =>
  options.getDatabase === undefined &&
  options.getPublishedBranding === undefined &&
  options.getAuthSettings === undefined &&
  options.getPublishedIdentityTarget === undefined;

const publicSnapshotCacheKey = async (flags: EnterpriseFeatureFlags): Promise<string> => {
  const epochs = await Promise.all(
    PUBLIC_SNAPSHOT_EPOCH_SCOPES.map((scope) => getPlatformConfigScopeVersion(scope)),
  );
  return `${getPlatformPublicSnapshotEpoch()}:${epochs.join(':')}:${JSON.stringify(flags)}`;
};

export { invalidatePlatformPublicSnapshot } from './publicSnapshotCache';

/** Test helper. */
export const resetPlatformPublicSnapshotForTest = (): void => {
  resetPlatformPublicSnapshotEpochForTest();
  publicSnapshotSlot = null;
  publicSnapshotInflight = null;
};

/**
 * Lazy DB boundary keeps the disabled feature path independent of database availability.
 * Branding is gated behind ENABLE_RUNTIME_BRANDING, but the login/registration projection
 * is always read so the anonymous login page can hide the sign-up link when registration is
 * closed — regardless of the branding flag.
 */
export const resolvePlatformPublicSnapshot = async (
  options: ResolvePlatformPublicSnapshotOptions,
): Promise<PublicSnapshot> => {
  if (!usesDefaultLoaders(options)) {
    return loadPlatformPublicSnapshot(options);
  }

  const key = await publicSnapshotCacheKey(options.flags);
  const now = Date.now();
  if (publicSnapshotSlot && publicSnapshotSlot.key === key && publicSnapshotSlot.expiresAt > now) {
    return publicSnapshotSlot.value;
  }
  if (publicSnapshotInflight?.key === key) return publicSnapshotInflight.promise;

  const promise = loadPlatformPublicSnapshot(options).then((value) => {
    publicSnapshotSlot = {
      expiresAt: Date.now() + PUBLIC_SNAPSHOT_TTL_MS,
      key,
      value,
    };
    return value;
  });
  publicSnapshotInflight = { key, promise };
  try {
    return await promise;
  } finally {
    if (publicSnapshotInflight?.promise === promise) publicSnapshotInflight = null;
  }
};

const loadPlatformPublicSnapshot = async ({
  flags,
  getDatabase = getServerDB,
  getPublishedBranding = (db) => new BrandingPublishedReadService(db).getPublished(),
  getAuthSettings = (db) => new PlatformAuthSettingsModel(db).get(),
  getPublishedIdentityTarget = (db) => loadPublishedIdentityTarget(db),
}: ResolvePlatformPublicSnapshotOptions): Promise<PublicSnapshot> => {
  let db: LobeChatDatabase;
  try {
    db = await getDatabase();
  } catch (error) {
    log(
      'database unavailable for public snapshot; using built-in fallback (%s)',
      error instanceof Error ? error.name : 'UnknownError',
    );
    return buildPlatformPublicSnapshot({ flags });
  }

  // Branding and auth are independent: a branding load failure must not force openRegistration
  // back to the built-in default (true) when registration is closed.
  let branding: PlatformBrandingPublished | null = null;
  if (flags.ENABLE_RUNTIME_BRANDING) {
    try {
      branding = await getPublishedBranding(db);
    } catch (error) {
      log(
        'published branding unavailable; continuing without branding (%s)',
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  }

  let openRegistration: boolean | undefined;
  try {
    const authSettings = await getAuthSettings(db);
    openRegistration = authSettings.openRegistration;
  } catch (error) {
    log(
      'auth settings unavailable; openRegistration falls back to built-in default (%s)',
      error instanceof Error ? error.name : 'UnknownError',
    );
  }

  // Work-account IdP is independent of branding/auth-settings. Loader failure fails closed.
  let workAccountEnabled: boolean | undefined;
  if (flags.ENABLE_DATABASE_OIDC) {
    try {
      const target = await getPublishedIdentityTarget(db);
      workAccountEnabled = target.providers.length > 0;
    } catch (error) {
      log(
        'published identity target unavailable; workAccountEnabled fails closed (%s)',
        error instanceof Error ? error.name : 'UnknownError',
      );
      workAccountEnabled = false;
    }
  }

  try {
    return buildPlatformPublicSnapshot({
      branding,
      flags,
      openRegistration,
      workAccountEnabled,
    });
  } catch (error) {
    log(
      'public snapshot projection invalid; using built-in fallback (%s)',
      error instanceof Error ? error.name : 'UnknownError',
    );
    return buildPlatformPublicSnapshot({ flags, openRegistration, workAccountEnabled });
  }
};
