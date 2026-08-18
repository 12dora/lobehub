import { randomUUID } from 'node:crypto';

import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import {
  assertBrowserInstallationId,
  composeBrowserDeviceProfileFromOptions,
  DEFAULT_BROWSER_DEVICE_PROFILE,
  generateBrowserDeviceProfile,
  listBrowserProfileOptions,
  resolveBrowserProfileOptionIds,
  validateBrowserDeviceProfile,
  validateBrowserDeviceProfileShape,
} from '@lobechat/model-runtime/browserProfile';
import debug from 'debug';
import { and, eq } from 'drizzle-orm';

import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import { PLATFORM_BROWSER_PROFILE_ID, platformBrowserProfiles } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileSummary,
} from '@/server/enterprise/contracts/adminBrowserProfile';
import {
  containsEnterpriseSecretMaterial,
  REDACTED_PLACEHOLDER,
} from '@/server/enterprise/security/redaction';
import { AUDIT_ACTION } from '@/server/enterprise/services/audit/auditActionCatalog';
import { resetCookieJars } from '@/server/enterprise/services/chatgptWeb/transport/cookieJar';
import { PlatformAuditService } from '@/server/enterprise/services/platformAudit';

const log = debug('lobe-server:browser-profile');

export const BROWSER_PROFILE_CACHE_TTL_MS = 60_000;

/** Audit reason recorded when a structurally broken stored profile is replaced. */
export const BROWSER_PROFILE_MIGRATION_REASON = 'profile migrated';

type PersistedBrowserDeviceProfile = Omit<BrowserDeviceProfile, 'installationId'> & {
  installationId?: string;
};

export interface PlatformBrowserProfileRecord {
  createdAt: Date;
  profile: BrowserDeviceProfile;
  revision: number;
  updatedAt: Date;
  updatedBy: string | null;
}

interface CacheEntry {
  expiresAt: number;
  record: PlatformBrowserProfileRecord;
}

const profileCache = new WeakMap<object, CacheEntry>();

const sanitizeAuditReason = (reason?: string): string | undefined => {
  const normalized = reason?.trim().slice(0, 500);
  if (!normalized) return undefined;
  return containsEnterpriseSecretMaterial(normalized) ? REDACTED_PLACEHOLDER : normalized;
};

/**
 * Reading a stored row validates its SHAPE only.
 *
 * Pool membership (Chrome build, platform version, screen, cores, locale bundle) is a
 * generation-time contract: Chrome versions rot and pools get repaired, and an
 * installation must keep presenting the identity it has been using upstream rather than
 * throw — which would degrade every request onto the shared bundled fallback. Only a row
 * that is not a coherent profile object is rejected, and the caller then migrates it.
 */
const toRecord = (
  row: typeof platformBrowserProfiles.$inferSelect,
): PlatformBrowserProfileRecord => {
  const profile = normalizePersistedProfile(row.profile as PersistedBrowserDeviceProfile);
  validateBrowserDeviceProfileShape(profile);
  if (profile.seed !== row.seed) throw new Error('Persisted browser profile seed mismatch');
  return {
    createdAt: row.createdAt,
    profile,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null,
  };
};

export const summarizeBrowserProfile = (
  record: PlatformBrowserProfileRecord,
): AdminBrowserProfileSummary => {
  const optionIds = resolveBrowserProfileOptionIds(record.profile);
  return {
    arch: record.profile.arch,
    chromeId: optionIds.chromeId,
    chromeVersion: record.profile.chrome.fullVersion,
    computeId: optionIds.computeId,
    cores: record.profile.hardwareConcurrency,
    createdAt: record.createdAt,
    impersonateProfile: record.profile.impersonateProfile,
    installationId: record.profile.installationId,
    locale: record.profile.oaiLanguage,
    localeId: optionIds.localeId,
    memoryGiB: record.profile.deviceMemoryGiB,
    platform: record.profile.platform,
    platformVersion: record.profile.platformVersion,
    revision: record.revision,
    screen: {
      dpr: record.profile.screen.dpr,
      height: record.profile.screen.height,
      width: record.profile.screen.width,
    },
    screenId: optionIds.screenId,
    systemId: optionIds.systemId,
    timezone: record.profile.timezone.iana,
    updatedAt: record.updatedAt,
    webglId: optionIds.webglId,
  };
};

const normalizePersistedProfile = (
  profile: PersistedBrowserDeviceProfile,
): BrowserDeviceProfile => {
  if (profile.installationId) {
    assertBrowserInstallationId(profile.installationId);
    return profile as BrowserDeviceProfile;
  }

  return {
    ...profile,
    installationId: assertBrowserInstallationId(profile.id),
  };
};

/** Installation-wide persisted synthetic browser profile. */
export class PlatformBrowserProfileService {
  private readonly cacheKey: object;

  constructor(private readonly db: LobeChatDatabase) {
    this.cacheKey = db as object;
  }

  get = async (): Promise<BrowserDeviceProfile> => (await this.getRecord()).profile;

  getFallback = (): BrowserDeviceProfile => DEFAULT_BROWSER_DEVICE_PROFILE;

  getOrFallback = async (): Promise<BrowserDeviceProfile> => {
    try {
      return await this.get();
    } catch (error) {
      // Error class only: the profile and its seed must never reach a log line.
      log('using fallback profile: %s', error instanceof Error ? error.name : 'UnknownError');
      return this.getFallback();
    }
  };

  getRecord = async ({ bypassCache = false } = {}): Promise<PlatformBrowserProfileRecord> => {
    const cached = profileCache.get(this.cacheKey);
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.record;

    const [existing] = await this.db
      .select()
      .from(platformBrowserProfiles)
      .where(eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID))
      .limit(1);
    if (existing) return this.remember(await this.readOrMigrate(existing));

    const seed = randomUUID();
    const profile = generateBrowserDeviceProfile({ seed });
    const [inserted] = await this.db
      .insert(platformBrowserProfiles)
      .values({
        id: PLATFORM_BROWSER_PROFILE_ID,
        profile,
        revision: 0,
        seed,
      })
      .onConflictDoNothing({ target: platformBrowserProfiles.id })
      .returning();
    if (inserted) return this.remember(toRecord(inserted));

    const [winner] = await this.db
      .select()
      .from(platformBrowserProfiles)
      .where(eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID))
      .limit(1);
    if (!winner) throw new Error('Failed to converge on a platform browser profile');
    return this.remember(await this.readOrMigrate(winner));
  };

  getSummary = async (): Promise<AdminBrowserProfileSummary> =>
    summarizeBrowserProfile(await this.getRecord());

  getOptions = (): AdminBrowserProfileOptions => listBrowserProfileOptions();

  invalidate = (): void => {
    profileCache.delete(this.cacheKey);
  };

  regenerate = async ({
    actorUserId,
    reason,
  }: {
    actorUserId: string;
    reason?: string;
  }): Promise<AdminBrowserProfileSummary> => {
    await this.getRecord({ bypassCache: true });

    const seed = randomUUID();
    const profile = generateBrowserDeviceProfile({ seed });
    const now = new Date();
    const record = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(platformBrowserProfiles)
        .where(eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID))
        .limit(1)
        .for('update');
      if (!locked) throw new Error('Platform browser profile disappeared during regeneration');

      const nextRevision = locked.revision + 1;
      const [updated] = await tx
        .update(platformBrowserProfiles)
        .set({
          profile,
          revision: nextRevision,
          seed,
          updatedAt: now,
          updatedBy: actorUserId,
        })
        .where(
          and(
            eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID),
            eq(platformBrowserProfiles.revision, locked.revision),
          ),
        )
        .returning();
      if (!updated) {
        throw new PlatformRevisionConflictError('Platform browser profile revision conflict');
      }

      await new PlatformAuditService(tx).append({
        action: AUDIT_ACTION.SYSTEM_BROWSER_PROFILE_REGENERATE,
        actorUserId,
        afterDiff: { revision: nextRevision },
        beforeDiff: { revision: locked.revision },
        configRevision: nextRevision,
        reason: sanitizeAuditReason(reason),
        result: 'success',
        targetId: PLATFORM_BROWSER_PROFILE_ID,
        targetType: 'system',
      });
      return toRecord(updated);
    });

    this.invalidate();
    resetCookieJars();
    return summarizeBrowserProfile(record);
  };

  async update({
    actorUserId,
    chromeId,
    computeId,
    localeId,
    reason,
    screenId,
    systemId,
    webglId,
  }: {
    actorUserId: string;
    chromeId: string;
    computeId: string;
    localeId: string;
    reason?: string;
    screenId: string;
    systemId: string;
    webglId: string;
  }): Promise<AdminBrowserProfileSummary> {
    await this.getRecord({ bypassCache: true });

    const selection = { chromeId, computeId, localeId, screenId, systemId, webglId };
    const now = new Date();
    const { record, resetJars } = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(platformBrowserProfiles)
        .where(eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID))
        .limit(1)
        .for('update');
      if (!locked) throw new Error('Platform browser profile disappeared during update');

      const current = toRecord(locked);
      const nextProfile = composeBrowserDeviceProfileFromOptions(
        selection,
        {
          dnt: current.profile.dnt,
          id: current.profile.id,
          installationId: current.profile.installationId,
          prefersColorScheme: current.profile.prefersColorScheme,
          prefersReducedMotion: current.profile.prefersReducedMotion,
          seed: current.profile.seed,
        },
        current.profile,
      );

      const identityRotated =
        nextProfile.userAgent !== current.profile.userAgent ||
        nextProfile.impersonateProfile !== current.profile.impersonateProfile;
      const profile = identityRotated
        ? validateBrowserDeviceProfile({ ...nextProfile, id: randomUUID() })
        : nextProfile;

      const nextRevision = locked.revision + 1;
      const [updated] = await tx
        .update(platformBrowserProfiles)
        .set({
          profile,
          revision: nextRevision,
          updatedAt: now,
          updatedBy: actorUserId,
        })
        .where(
          and(
            eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID),
            eq(platformBrowserProfiles.revision, locked.revision),
          ),
        )
        .returning();
      if (!updated) {
        throw new PlatformRevisionConflictError('Platform browser profile revision conflict');
      }

      const beforeIds = resolveBrowserProfileOptionIds(current.profile);
      const afterIds = resolveBrowserProfileOptionIds(profile);
      await new PlatformAuditService(tx).append({
        action: AUDIT_ACTION.SYSTEM_BROWSER_PROFILE_UPDATE,
        actorUserId,
        afterDiff: {
          chromeId: afterIds.chromeId,
          computeId: afterIds.computeId,
          identityRotated,
          localeId: afterIds.localeId,
          revision: nextRevision,
          screenId: afterIds.screenId,
          systemId: afterIds.systemId,
          webglId: afterIds.webglId,
        },
        beforeDiff: {
          chromeId: beforeIds.chromeId,
          computeId: beforeIds.computeId,
          localeId: beforeIds.localeId,
          revision: locked.revision,
          screenId: beforeIds.screenId,
          systemId: beforeIds.systemId,
          webglId: beforeIds.webglId,
        },
        configRevision: nextRevision,
        reason: sanitizeAuditReason(reason),
        result: 'success',
        targetId: PLATFORM_BROWSER_PROFILE_ID,
        targetType: 'system',
      });
      return { record: toRecord(updated), resetJars: identityRotated };
    });

    this.invalidate();
    if (resetJars) resetCookieJars();
    return summarizeBrowserProfile(record);
  }

  private remember = (record: PlatformBrowserProfileRecord): PlatformBrowserProfileRecord => {
    const previous = profileCache.get(this.cacheKey);
    if (previous && previous.record.profile.id !== record.profile.id) resetCookieJars();
    profileCache.set(this.cacheKey, {
      expiresAt: Date.now() + BROWSER_PROFILE_CACHE_TTL_MS,
      record,
    });
    return record;
  };

  /**
   * Read a stored row. A row that is no longer a usable profile object (truncated JSON,
   * a payload written by an incompatible schema, a seed that disagrees with its column)
   * is REPLACED — regenerated, persisted with a revision bump and audited — instead of
   * throwing every request onto the shared fallback identity. Drift against the current
   * pools is not a defect and never triggers this path.
   */
  private readOrMigrate = async (
    row: typeof platformBrowserProfiles.$inferSelect,
  ): Promise<PlatformBrowserProfileRecord> => {
    let record: PlatformBrowserProfileRecord;
    try {
      record = toRecord(row);
    } catch (error) {
      // Error class only: a malformed payload must never be echoed into a log line.
      log(
        'replacing an unusable stored profile: %s',
        error instanceof Error ? error.name : 'UnknownError',
      );
      const migrated = await this.migrateUnusableProfile();
      resetCookieJars();
      return migrated;
    }
    return this.persistProfileRepair(row, record);
  };

  /** Regenerate + persist + audit in one transaction; a concurrent winner is reread. */
  private migrateUnusableProfile = async (): Promise<PlatformBrowserProfileRecord> => {
    const seed = randomUUID();
    const profile = generateBrowserDeviceProfile({ seed });
    const now = new Date();

    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(platformBrowserProfiles)
        .where(eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID))
        .limit(1)
        .for('update');
      if (!locked) throw new Error('Platform browser profile disappeared during migration');

      try {
        // Another instance migrated the same row first.
        return toRecord(locked);
      } catch {
        // Still unusable — replace it.
      }

      const nextRevision = locked.revision + 1;
      const [updated] = await tx
        .update(platformBrowserProfiles)
        .set({ profile, revision: nextRevision, seed, updatedAt: now, updatedBy: null })
        .where(
          and(
            eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID),
            eq(platformBrowserProfiles.revision, locked.revision),
          ),
        )
        .returning();
      if (!updated) throw new Error('Platform browser profile revision conflict during migration');

      await new PlatformAuditService(tx).append({
        action: AUDIT_ACTION.SYSTEM_BROWSER_PROFILE_REGENERATE,
        actorUserId: null,
        afterDiff: { migrated: true, revision: nextRevision },
        beforeDiff: { revision: locked.revision },
        configRevision: nextRevision,
        reason: BROWSER_PROFILE_MIGRATION_REASON,
        result: 'success',
        targetId: PLATFORM_BROWSER_PROFILE_ID,
        targetType: 'system',
      });
      return toRecord(updated);
    });
  };

  private persistProfileRepair = async (
    row: typeof platformBrowserProfiles.$inferSelect,
    record: PlatformBrowserProfileRecord,
  ): Promise<PlatformBrowserProfileRecord> => {
    const persistedProfile = row.profile as PersistedBrowserDeviceProfile;
    if (persistedProfile.installationId === record.profile.installationId) return record;

    const [updated] = await this.db
      .update(platformBrowserProfiles)
      .set({ profile: record.profile })
      .where(
        and(
          eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID),
          eq(platformBrowserProfiles.revision, row.revision),
        ),
      )
      .returning();
    if (updated) return toRecord(updated);

    const [winner] = await this.db
      .select()
      .from(platformBrowserProfiles)
      .where(eq(platformBrowserProfiles.id, PLATFORM_BROWSER_PROFILE_ID))
      .limit(1);
    if (!winner) throw new Error('Failed to reread platform browser profile after repair conflict');
    return toRecord(winner);
  };
}
