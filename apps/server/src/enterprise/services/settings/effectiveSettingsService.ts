/**
 * Runtime effective settings service (M05).
 *
 * Loads published policies + user overrides, resolves via pure resolver,
 * and exposes patch/reset + legacy updateSettings adapter.
 *
 * Cache: process-local Map keyed by registry+platformRev+userOverrideRev.
 * Multi-instance correctness relies on PlatformConfigInvalidationPublisher
 * (bounded degradation if an instance misses an event until next read TTL).
 */

import { MANAGED_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { checksumPayload, PlatformSettingsModel } from '@/database/models/platform';
import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';
import type {
  EffectiveSettingsResult,
  SettingClientSurface,
  SettingPolicyMode,
  SettingPolicyVisibility,
} from '@/types/platform/settings';

import { getEnterpriseFeatureFlags } from '../../featureFlags';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import {
  classifyRuntimeMaterializationError,
  type PlatformRuntimeMaterializationReporter,
  reportPlatformRuntimeMaterialization,
  reportPlatformRuntimeMaterializationSafely,
} from '../platformInstance/runtimeReporter';
import { buildSettingsCacheKey, resolveEffectiveSettings } from './effectiveResolver';
import { validateLegacySettingsUpdate } from './legacySettingsCatalog';
import { deleteByPath, flattenLeaves, getByPath } from './pathUtils';
import { settingsRegistry } from './registry';

/** Drop secrets and normalize empty legacy for cache keys. */
const sanitizeLegacyForCache = (
  legacy: Record<string, unknown> | null | undefined,
): Record<string, unknown> => {
  if (!legacy) return {};
  const { keyVaults: _keyVaults, ...rest } = legacy;
  return rest;
};

const legacyCacheChecksum = (legacy: Record<string, unknown> | null | undefined): string =>
  checksumPayload(sanitizeLegacyForCache(legacy));

export class SettingsPathError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SettingsPathError';
  }
}

// Re-export codes for call sites
export { MANAGED_ERROR_CODES, PLATFORM_ERROR_CODES };

/** Soft process-local cache — not a multi-instance guarantee. */
type SoftCacheEntry = {
  /** Absolute expiry from insertion/materialization — hits must not renew this. */
  expiresAt: number;
  value: EffectiveSettingsResult;
};
const softCache = new Map<string, SoftCacheEntry>();
const SOFT_CACHE_TTL_MS = 5_000;
/** Bound resident keys so historical user/revision traffic cannot grow unbounded. */
const SOFT_CACHE_MAX_ENTRIES = 512;

/**
 * Process-local published-policy rows keyed by platform revision.
 * Avoids re-SELECTing the same org policies on every user materialization
 * (soft-cache is per-user; this is shared across users at a revision).
 */
type PublishedPolicyMap = Record<
  string,
  {
    mode: SettingPolicyMode;
    schemaVersion: number;
    value: unknown;
    visibility: SettingPolicyVisibility;
  }
>;
const publishedPoliciesByRevision = new Map<number, PublishedPolicyMap>();
const PUBLISHED_POLICIES_CACHE_MAX = 16;

const readPublishedPoliciesCache = (platformRevision: number): PublishedPolicyMap | undefined => {
  const cached = publishedPoliciesByRevision.get(platformRevision);
  if (!cached) return undefined;
  // Refresh LRU insertion order.
  publishedPoliciesByRevision.delete(platformRevision);
  publishedPoliciesByRevision.set(platformRevision, cached);
  return cached;
};

const writePublishedPoliciesCache = (
  platformRevision: number,
  policies: PublishedPolicyMap,
): void => {
  publishedPoliciesByRevision.delete(platformRevision);
  publishedPoliciesByRevision.set(platformRevision, policies);
  while (publishedPoliciesByRevision.size > PUBLISHED_POLICIES_CACHE_MAX) {
    const oldest = publishedPoliciesByRevision.keys().next().value;
    if (oldest === undefined) break;
    publishedPoliciesByRevision.delete(oldest);
  }
};

/**
 * Users with the same platform revision, override revision token, and legacy
 * checksum resolve to identical EffectiveSettingsResult payloads. Memoize the
 * pure resolve so multi-user first-fill (soft-cache cold) does not re-walk the
 * full registry for every user.
 */
const resolvedByLayerKey = new Map<string, EffectiveSettingsResult>();
const RESOLVED_LAYER_CACHE_MAX = 64;

const buildResolvedLayerKey = (params: {
  legacyChecksum: string;
  platformRevision: number;
  registryVersion: number;
  userOverrideRevision: number;
}): string =>
  `r${params.registryVersion}:p${params.platformRevision}:o${params.userOverrideRevision}:l${params.legacyChecksum}`;

const readResolvedLayerCache = (key: string): EffectiveSettingsResult | undefined => {
  const cached = resolvedByLayerKey.get(key);
  if (!cached) return undefined;
  resolvedByLayerKey.delete(key);
  resolvedByLayerKey.set(key, cached);
  return cached;
};

const writeResolvedLayerCache = (key: string, value: EffectiveSettingsResult): void => {
  resolvedByLayerKey.delete(key);
  resolvedByLayerKey.set(key, value);
  while (resolvedByLayerKey.size > RESOLVED_LAYER_CACHE_MAX) {
    const oldest = resolvedByLayerKey.keys().next().value;
    if (oldest === undefined) break;
    resolvedByLayerKey.delete(oldest);
  }
};

const pruneSoftCache = (now: number): void => {
  for (const [key, entry] of softCache) {
    if (now >= entry.expiresAt) softCache.delete(key);
  }
  while (softCache.size > SOFT_CACHE_MAX_ENTRIES) {
    const oldest = softCache.keys().next().value;
    if (oldest === undefined) break;
    softCache.delete(oldest);
  }
};

const readSoftCache = (key: string): EffectiveSettingsResult | undefined => {
  const now = Date.now();
  const cached = softCache.get(key);
  if (!cached) return undefined;
  if (now >= cached.expiresAt) {
    softCache.delete(key);
    return undefined;
  }
  // Refresh insertion order for LRU eviction only — keep absolute expiresAt (not sliding TTL).
  softCache.delete(key);
  softCache.set(key, cached);
  return cached.value;
};

const writeSoftCache = (key: string, value: EffectiveSettingsResult): void => {
  const now = Date.now();
  softCache.delete(key);
  softCache.set(key, { expiresAt: now + SOFT_CACHE_TTL_MS, value });
  pruneSoftCache(now);
};

/**
 * Narrow transaction lifecycle seam. Production leaves this empty; causal
 * concurrency and rollback tests use promise barriers/fault injection without
 * replacing the service or mirroring its transaction logic.
 */
export interface SettingsMutationLifecycle {
  afterBundleLock?: (operation: 'fullReset' | 'legacyUpdate' | 'patch' | 'reset') => Promise<void>;
  afterManagedOverrideWrite?: (operation: 'legacyUpdate', index: number) => Promise<void>;
  afterManagedWrites?: (operation: 'fullReset' | 'legacyUpdate') => Promise<void>;
  beforeBundleLock?: (operation: 'fullReset' | 'legacyUpdate' | 'patch' | 'reset') => Promise<void>;
  beforeLegacyWrite?: (operation: 'fullReset' | 'legacyUpdate') => Promise<void>;
  beforeOverrideRevisionBump?: (operation: 'legacyUpdate') => Promise<void>;
}

export class EffectiveSettingsService {
  private readonly db: LobeChatDatabase;
  private readonly model: PlatformSettingsModel;
  private readonly invalidation: PlatformConfigInvalidationPublisher;
  private readonly lifecycle: SettingsMutationLifecycle;
  private readonly runtimeReporter: PlatformRuntimeMaterializationReporter;

  constructor(
    db: LobeChatDatabase,
    invalidation: PlatformConfigInvalidationPublisher = getPlatformConfigInvalidationPublisher(),
    lifecycle: SettingsMutationLifecycle = {},
    runtimeReporter: PlatformRuntimeMaterializationReporter = reportPlatformRuntimeMaterialization,
  ) {
    this.db = db;
    this.model = new PlatformSettingsModel(db);
    this.invalidation = invalidation;
    this.lifecycle = lifecycle;
    this.runtimeReporter = runtimeReporter;
  }

  isPolicyEnabled = (): boolean => getEnterpriseFeatureFlags().ENABLE_PLATFORM_SETTINGS_POLICY;

  /**
   * Platform layer only (builtin + published policies, no personal overrides/legacy).
   * Used for workspace-scoped agent merges so org locks/defaults apply without
   * leaking personal settings (B1-R2).
   */
  getPlatformLayerEffectiveSettings = async (): Promise<EffectiveSettingsResult> => {
    if (!this.isPolicyEnabled()) {
      return resolveEffectiveSettings({
        legacyUserSettings: {},
        platformPolicyEnabled: false,
        platformRevision: 0,
        userOverrideRevision: 0,
      });
    }

    let snapshot: Awaited<ReturnType<PlatformSettingsModel['readEffectiveSettingsSnapshot']>>;
    try {
      snapshot = await this.model.readEffectiveSettingsSnapshot({ userId: null });
    } catch (error) {
      this.reportUnavailable(error);
      throw error;
    }
    const policies: Record<
      string,
      {
        mode: SettingPolicyMode;
        schemaVersion: number;
        value: unknown;
        visibility: SettingPolicyVisibility;
      }
    > = {};
    for (const row of snapshot.published) {
      policies[row.path] = {
        mode: row.mode as SettingPolicyMode,
        schemaVersion: row.schemaVersion,
        value: row.value,
        visibility: (row.visibility ?? 'visible') as SettingPolicyVisibility,
      };
    }

    return resolveEffectiveSettings({
      legacyUserSettings: {},
      overrides: {},
      platformPolicyEnabled: true,
      platformRevision: snapshot.platformRevision,
      policies,
      userOverrideRevision: 0,
    });
  };

  /**
   * Resolve effective settings for a user.
   * Flag OFF: pure legacy blob + built-ins (no platform table reads required).
   * Flag ON: idempotently backfills registered legacy leaves into override rows,
   * then resolves policy + overrides (+ remaining legacy for unregistered keys).
   */
  getEffectiveSettings = async (params: {
    legacyUserSettings?: Record<string, unknown> | null;
    userId: string;
  }): Promise<EffectiveSettingsResult> => {
    const flagOn = this.isPolicyEnabled();
    const legacyUserSettings = params.legacyUserSettings ?? {};

    if (!flagOn) {
      return resolveEffectiveSettings({
        legacyUserSettings,
        platformPolicyEnabled: false,
        platformRevision: 0,
        userOverrideRevision: 0,
      });
    }

    // Cheap single-statement revision probe for soft-cache hits.
    // On miss, reuse process-local published policies for the platform revision
    // and skip override SELECTs when the user revision token is still 0 (never written).
    let probePlatformRevision: number;
    let probeUserOverrideRevision: number;
    try {
      const probe = await this.model.getRevisionTokens(params.userId);
      probePlatformRevision = probe.platformRevision;
      probeUserOverrideRevision = probe.userOverrideRevision;
    } catch (error) {
      this.reportUnavailable(error);
      throw error;
    }

    const legacyChecksum = legacyCacheChecksum(legacyUserSettings);
    const probeCacheKey = buildSettingsCacheKey({
      legacyChecksum,
      platformRevision: probePlatformRevision,
      registryVersion: settingsRegistry.version,
      userId: params.userId,
      userOverrideRevision: probeUserOverrideRevision,
    });

    const cached = readSoftCache(probeCacheKey);
    if (cached) {
      return cached;
    }

    let platformRevision: number;
    let userOverrideRevision: number;
    let policies: PublishedPolicyMap;
    let overrides: Record<string, { value: unknown }>;
    try {
      const materialised = await this.materializeUserSettingsLayers({
        seedRevisions: {
          platformRevision: probePlatformRevision,
          userOverrideRevision: probeUserOverrideRevision,
        },
        userId: params.userId,
      });
      platformRevision = materialised.platformRevision;
      userOverrideRevision = materialised.userOverrideRevision;
      policies = materialised.policies;
      overrides = materialised.overrides;
    } catch (error) {
      this.reportUnavailable(error);
      throw error;
    }

    // One-time migration: copy validated registered legacy leaves into override rows.
    // Idempotent (ON CONFLICT DO NOTHING); never overwrites an existing override.
    try {
      const backfilled = await this.backfillRegisteredLegacyOverrides({
        legacyUserSettings,
        overrides,
        userId: params.userId,
      });
      if (backfilled) {
        userOverrideRevision = backfilled.revision;
        for (const [path, value] of Object.entries(backfilled.overrides)) {
          overrides[path] = value;
        }
      }
    } catch (error) {
      this.reportUnavailable(error);
      throw error;
    }

    // Pure resolve is identical for every user at the same platform revision with no
    // overrides and the same legacy checksum — reuse it so multi-user cold fill is
    // dominated by the revision probe, not registry walks.
    const canShareResolved = userOverrideRevision === 0 && Object.keys(overrides).length === 0;
    const layerKey = canShareResolved
      ? buildResolvedLayerKey({
          legacyChecksum,
          platformRevision,
          registryVersion: settingsRegistry.version,
          userOverrideRevision,
        })
      : null;
    let result = layerKey ? readResolvedLayerCache(layerKey) : undefined;
    if (!result) {
      result = resolveEffectiveSettings({
        legacyUserSettings,
        overrides,
        platformPolicyEnabled: true,
        platformRevision,
        policies,
        userOverrideRevision,
      });
      if (layerKey) writeResolvedLayerCache(layerKey, result);
    }

    // Soft-cache stays per-user (LRU bound); layer memo only skips pure resolve work.
    writeSoftCache(
      buildSettingsCacheKey({
        legacyChecksum,
        platformRevision,
        registryVersion: settingsRegistry.version,
        userId: params.userId,
        userOverrideRevision,
      }),
      result,
    );
    reportPlatformRuntimeMaterializationSafely(this.runtimeReporter, this.db, {
      domain: 'settings',
      health: 'healthy',
      revision: platformRevision,
      source: 'database',
    });
    return result;
  };

  /**
   * Load published policies + user overrides coherently for one user.
   *
   * Hot path: process-cached policies by platform revision + skip override reads
   * when userOverrideRevision is 0. Bracket with a closing token read when any
   * row SELECT ran; on sustained mismatch fall back to a single-statement snapshot
   * (never throw SETTINGS_SNAPSHOT_RETRY to the caller).
   */
  private materializeUserSettingsLayers = async (params: {
    seedRevisions: { platformRevision: number; userOverrideRevision: number };
    userId: string;
  }): Promise<{
    overrides: Record<string, { value: unknown }>;
    platformRevision: number;
    policies: PublishedPolicyMap;
    userOverrideRevision: number;
  }> => {
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const before =
        attempt === 0 ? params.seedRevisions : await this.model.getRevisionTokens(params.userId);

      let policyMap = readPublishedPoliciesCache(before.platformRevision);
      let loadedPoliciesFromDb = false;
      if (!policyMap) {
        const rows = await this.model.listPublishedPolicies();
        policyMap = {};
        for (const row of rows) {
          policyMap[row.path] = {
            mode: row.mode as SettingPolicyMode,
            schemaVersion: row.schemaVersion,
            value: row.value,
            visibility: (row.visibility ?? 'visible') as SettingPolicyVisibility,
          };
        }
        loadedPoliciesFromDb = true;
      }

      // Revision 0 means the user has never written overrides (bump is transactional
      // with every insert/delete). Skip the empty SELECT on the common first-read path.
      let overrideRows: Awaited<ReturnType<PlatformSettingsModel['listUserOverrides']>> = [];
      let loadedOverridesFromDb = false;
      if (before.userOverrideRevision > 0) {
        overrideRows = await this.model.listUserOverrides(params.userId);
        loadedOverridesFromDb = true;
      }

      // Cached policies for revision R plus empty overrides at user rev 0 need no
      // recheck: concurrent publish advances the platform token (next probe misses),
      // and concurrent first patch advances the user token the same way.
      const needsRecheck = loadedPoliciesFromDb || loadedOverridesFromDb;
      if (needsRecheck) {
        const after = await this.model.getRevisionTokens(params.userId);
        if (
          before.platformRevision !== after.platformRevision ||
          before.userOverrideRevision !== after.userOverrideRevision
        ) {
          continue;
        }
        if (loadedPoliciesFromDb) {
          writePublishedPoliciesCache(before.platformRevision, policyMap);
        }
      }

      const overrides: Record<string, { value: unknown }> = {};
      for (const row of overrideRows) {
        overrides[row.path] = { value: row.value };
      }

      return {
        overrides,
        platformRevision: before.platformRevision,
        policies: policyMap,
        userOverrideRevision: before.userOverrideRevision,
      };
    }

    // Sustained churn: one statement-level snapshot — coherent and never throws
    // SETTINGS_SNAPSHOT_RETRY (settings reads must not become an outage mode).
    const snapshot = await this.model.readEffectiveSettingsSnapshot({ userId: params.userId });
    const policies: PublishedPolicyMap = {};
    for (const row of snapshot.published) {
      policies[row.path] = {
        mode: row.mode as SettingPolicyMode,
        schemaVersion: row.schemaVersion,
        value: row.value,
        visibility: (row.visibility ?? 'visible') as SettingPolicyVisibility,
      };
    }
    writePublishedPoliciesCache(snapshot.platformRevision, policies);
    const overrides: Record<string, { value: unknown }> = {};
    for (const row of snapshot.overrideRows) {
      overrides[row.path] = { value: row.value };
    }
    return {
      overrides,
      platformRevision: snapshot.platformRevision,
      policies,
      userOverrideRevision: snapshot.userOverrideRevision,
    };
  };

  /**
   * Copy registered legacy leaves into `user_setting_overrides` when no override exists.
   * Strips those leaves from the caller's legacy blob in DB after insert so a later
   * reset does not re-materialize the same preference.
   */
  private backfillRegisteredLegacyOverrides = async (params: {
    legacyUserSettings: Record<string, unknown>;
    overrides: Record<string, { value: unknown }>;
    userId: string;
  }): Promise<{ overrides: Record<string, { value: unknown }>; revision: number } | null> => {
    const ops: Array<{ path: string; value: unknown }> = [];
    for (const entry of settingsRegistry.list()) {
      if (params.overrides[entry.path]) continue;
      if (settingsRegistry.isSecretPath(entry.path)) continue;
      const leaf = getByPath(params.legacyUserSettings, entry.path);
      if (leaf === undefined) continue;
      const validated = settingsRegistry.validateValue(entry.path, leaf);
      if (!validated.ok) continue;
      ops.push({ path: entry.path, value: validated.value });
    }
    if (ops.length === 0) return null;

    const { insertedPaths, revision } = await this.model.insertUserOverridesIfAbsent({
      ops,
      source: 'legacy_migration',
      userId: params.userId,
    });
    if (insertedPaths.length === 0) return null;

    const nextOverrides = { ...params.overrides };
    for (const path of insertedPaths) {
      const op = ops.find((item) => item.path === path);
      if (op) nextOverrides[path] = { value: op.value };
    }

    // Strip migrated registered leaves from durable legacy so reset cannot re-backfill them.
    // Always load the full user_settings row — callers often pass partial legacy slices.
    await this.stripRegisteredLegacyLeaves(params.userId, insertedPaths);

    return { overrides: nextOverrides, revision };
  };

  private stripRegisteredLegacyLeaves = async (userId: string, paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    const userModel = new UserModel(this.db, userId);
    const row = await userModel.getUserSettings();
    if (!row) return;

    const touchedTops = new Set<string>();
    for (const path of paths) {
      const top = path.split('.')[0];
      if (top && top !== 'keyVaults') touchedTops.add(top);
    }
    if (touchedTops.size === 0) return;

    // Build a full top-level snapshot for the columns we will rewrite.
    let tree: Record<string, unknown> = {};
    for (const top of touchedTops) {
      tree[top] = (row as Record<string, unknown>)[top];
    }
    for (const path of paths) {
      tree = deleteByPath(tree, path);
    }

    const patch: Record<string, unknown> = {};
    for (const top of touchedTops) {
      patch[top] = tree[top] ?? null;
    }
    await userModel.updateSetting(patch as Parameters<UserModel['updateSetting']>[0]);
  };

  private reportUnavailable = (error: unknown): void => {
    // Force recovery through a new materialization instead of leaving the reporter unavailable
    // while subsequent requests keep serving a pre-failure cache hit at the same revision.
    softCache.clear();
    publishedPoliciesByRevision.clear();
    resolvedByLayerKey.clear();
    reportPlatformRuntimeMaterializationSafely(this.runtimeReporter, this.db, {
      domain: 'settings',
      errorCategory: classifyRuntimeMaterializationError(error),
      health: 'unavailable',
      source: 'unavailable',
    });
  };

  patchSettingOverride = async (params: {
    /** Server-trusted surface (never client-asserted alone). */
    client?: SettingClientSurface;
    path: string;
    userId: string;
    value: unknown;
  }) => {
    if (!this.isPolicyEnabled()) {
      throw new SettingsPathError(PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED);
    }

    const gate = settingsRegistry.assertPathWritable({
      client: params.client ?? 'web',
      path: params.path,
    });
    if (gate) throw new SettingsPathError(gate);

    const validated = settingsRegistry.validateValue(params.path, params.value);
    if (!validated.ok) {
      throw new SettingsPathError(
        MANAGED_ERROR_CODES.MANAGED_SETTING_INVALID_VALUE,
        validated.message,
      );
    }

    // B3-R2: lock aggregate pointer + recheck published policy inside same txn as write
    const { revision } = await this.db.transaction(async (tx) => {
      const model = new PlatformSettingsModel(tx);
      await this.lifecycle.beforeBundleLock?.('patch');
      await model.lockBundleForUpdate();
      await this.lifecycle.afterBundleLock?.('patch');
      const policy = await model.getPublishedPolicy(params.path);
      if (policy?.mode === 'locked') {
        throw new SettingsPathError(MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN);
      }
      return model.upsertUserOverride({
        alreadyInTransaction: true,
        path: params.path,
        userId: params.userId,
        value: validated.value,
      });
    });

    this.dropUserCache(params.userId);
    await this.invalidation.publish({
      at: new Date().toISOString(),
      resourceId: params.userId,
      resourceType: 'settings',
      revision,
      scopes: ['settings', `user:${params.userId}`],
    });

    return { path: params.path, revision, value: validated.value };
  };

  resetSettingOverride = async (params: {
    client?: SettingClientSurface;
    path: string;
    userId: string;
  }) => {
    if (!this.isPolicyEnabled()) {
      throw new SettingsPathError(PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED);
    }

    const gate = settingsRegistry.assertPathWritable({
      client: params.client ?? 'web',
      path: params.path,
    });
    if (gate) throw new SettingsPathError(gate);

    const result = await this.db.transaction(async (tx) => {
      const model = new PlatformSettingsModel(tx);
      await this.lifecycle.beforeBundleLock?.('reset');
      await model.lockBundleForUpdate();
      await this.lifecycle.afterBundleLock?.('reset');
      const policy = await model.getPublishedPolicy(params.path);
      if (policy?.mode === 'locked') {
        throw new SettingsPathError(MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN);
      }
      const deleted = await model.deleteUserOverride(params.userId, params.path, {
        alreadyInTransaction: true,
      });
      // Clear the registered leaf from legacy so resolve/backfill cannot re-apply it.
      const userModel = new UserModel(tx as LobeChatDatabase, params.userId);
      const row = await userModel.getUserSettings();
      if (row) {
        const top = params.path.split('.')[0];
        if (top && top !== 'keyVaults') {
          const blob = (row as Record<string, unknown>)[top];
          if (blob !== null && blob !== undefined && typeof blob === 'object') {
            const stripped = deleteByPath({ [top]: blob } as Record<string, unknown>, params.path);
            await userModel.updateSetting({
              [top]: stripped[top] ?? null,
            } as Parameters<UserModel['updateSetting']>[0]);
          }
        }
      }
      return deleted;
    });

    this.dropUserCache(params.userId);
    await this.invalidation.publish({
      at: new Date().toISOString(),
      resourceId: params.userId,
      resourceType: 'settings',
      revision: result.revision,
      scopes: ['settings', `user:${params.userId}`],
    });

    return { deleted: result.deleted, path: params.path, revision: result.revision };
  };

  /**
   * Full settings reset (old-client compatibility when flag ON).
   * Atomically: delete all overrides + bump revision + delete legacy user_settings (incl. keyVaults).
   */
  fullResetSettings = async (params: { userId: string }) => {
    if (!this.isPolicyEnabled()) {
      const userModel = new UserModel(this.db, params.userId);
      return userModel.deleteSetting();
    }

    const revision = await this.db.transaction(async (tx) => {
      const model = new PlatformSettingsModel(tx);
      await this.lifecycle.beforeBundleLock?.('fullReset');
      await model.lockBundleForUpdate();
      await this.lifecycle.afterBundleLock?.('fullReset');
      const result = await model.deleteAllUserOverrides(params.userId, {
        alreadyInTransaction: true,
      });
      await this.lifecycle.afterManagedWrites?.('fullReset');
      await this.lifecycle.beforeLegacyWrite?.('fullReset');
      const userModel = new UserModel(tx as LobeChatDatabase, params.userId);
      await userModel.deleteSetting();
      return result;
    });

    this.dropUserCache(params.userId);
    await this.invalidation.publish({
      at: new Date().toISOString(),
      resourceId: params.userId,
      resourceType: 'settings',
      revision,
      scopes: ['settings', `user:${params.userId}`],
    });
  };

  /**
   * Legacy updateSettings when flag is ON — validate entire request first, then
   * one transaction: re-check locks, write all overrides, bump revision once,
   * write legacy remainder + encrypted keyVaults. Invalidate only after commit.
   */
  applyLegacyUpdateSettings = async (params: {
    /** Pre-encrypted keyVaults string, or null to skip, or undefined if absent. */
    encryptedKeyVaults?: string | null;
    input: Record<string, unknown>;
    userId: string;
  }): Promise<{ appliedPaths: string[] }> => {
    if (!this.isPolicyEnabled()) {
      throw new SettingsPathError(PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED);
    }

    // 1) Strict catalog validation — zero writes on failure
    const catalog = validateLegacySettingsUpdate(params.input);
    if (!catalog.ok) {
      throw new SettingsPathError(catalog.error.code, catalog.error.message);
    }

    const validatedInput = catalog.value as Record<string, unknown>;
    const leaves = flattenLeaves(validatedInput).filter((l) => !l.path.startsWith('keyVaults'));
    const ops: Array<{ path: string; value: unknown }> = [];

    for (const leaf of leaves) {
      const { path, value } = leaf;
      if (settingsRegistry.isSecretPath(path)) {
        throw new SettingsPathError(
          MANAGED_ERROR_CODES.MANAGED_SETTING_SECRET_PATH,
          `Secret path not allowed: ${path}`,
        );
      }
      if (!settingsRegistry.has(path)) {
        // known catalog leaf not in platform registry → stays in legacy partial
        continue;
      }
      // Legacy updateSettings is a user-facing client API (web/desktop/mobile)
      const gate = settingsRegistry.assertPathWritable({ client: 'web', path });
      if (gate) throw new SettingsPathError(gate);

      const validated = settingsRegistry.validateValue(path, value);
      if (!validated.ok) {
        throw new SettingsPathError(
          MANAGED_ERROR_CODES.MANAGED_SETTING_INVALID_VALUE,
          validated.message,
        );
      }
      ops.push({ path, value: validated.value });
    }

    // Build legacy partial (non-registered known leaves + hotkey etc.)
    const legacyPartial: Record<string, unknown> = {};
    for (const [topKey, topVal] of Object.entries(validatedInput)) {
      if (topKey === 'keyVaults') continue;
      if (settingsRegistry.isSecretPath(topKey)) continue;

      const topRegistered = settingsRegistry
        .paths()
        .some((p) => p === topKey || p.startsWith(`${topKey}.`));
      if (!topRegistered) {
        legacyPartial[topKey] = topVal;
        continue;
      }
      const nestedLeaves = flattenLeaves(topVal, topKey);
      const unregistered = nestedLeaves.filter((l) => !settingsRegistry.has(l.path));
      if (unregistered.length === 0) continue;
      let partial: Record<string, unknown> = {};
      for (const leaf of unregistered) {
        const rel = leaf.path.startsWith(`${topKey}.`)
          ? leaf.path.slice(topKey.length + 1)
          : leaf.path;
        if (!rel || rel === topKey) {
          partial = leaf.value as Record<string, unknown>;
        } else {
          const parts = rel.split('.');
          let cur = partial;
          for (let i = 0; i < parts.length - 1; i++) {
            const k = parts[i]!;
            cur[k] = cur[k] && typeof cur[k] === 'object' ? { ...(cur[k] as object) } : {};
            cur = cur[k] as Record<string, unknown>;
          }
          cur[parts.at(-1)!] = leaf.value;
        }
      }
      if (Object.keys(partial).length > 0) legacyPartial[topKey] = partial;
    }

    if (params.encryptedKeyVaults !== undefined && params.encryptedKeyVaults !== null) {
      legacyPartial.keyVaults = params.encryptedKeyVaults;
    }

    // 2) Single transaction: re-check locks, overrides, revision, legacy write
    let revision = 0;
    await this.db.transaction(async (tx) => {
      const model = new PlatformSettingsModel(tx);
      await this.lifecycle.beforeBundleLock?.('legacyUpdate');
      await model.lockBundleForUpdate();
      await this.lifecycle.afterBundleLock?.('legacyUpdate');
      for (const op of ops) {
        const policy = await model.getPublishedPolicy(op.path);
        if (policy?.mode === 'locked') {
          throw new SettingsPathError(MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN);
        }
      }
      if (ops.length > 0) {
        revision = await model.upsertUserOverridesBatch({
          afterOverrideWrite: async (index) =>
            this.lifecycle.afterManagedOverrideWrite?.('legacyUpdate', index),
          alreadyInTransaction: true,
          beforeRevisionBump: async () =>
            this.lifecycle.beforeOverrideRevisionBump?.('legacyUpdate'),
          ops,
          userId: params.userId,
        });
      }
      await this.lifecycle.afterManagedWrites?.('legacyUpdate');
      if (Object.keys(legacyPartial).length > 0) {
        await this.lifecycle.beforeLegacyWrite?.('legacyUpdate');
        const userModel = new UserModel(tx as LobeChatDatabase, params.userId);
        await userModel.updateSetting(legacyPartial as Parameters<UserModel['updateSetting']>[0]);
      }
    });

    this.dropUserCache(params.userId);
    if (ops.length > 0 || Object.keys(legacyPartial).length > 0) {
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: params.userId,
        resourceType: 'settings',
        revision,
        scopes: ['settings', `user:${params.userId}`],
      });
    }

    return { appliedPaths: ops.map((o) => o.path) };
  };

  private dropUserCache = (userId: string) => {
    for (const key of softCache.keys()) {
      if (key.includes(`:u${userId}:`)) softCache.delete(key);
    }
  };
}

export const resetEffectiveSettingsCacheForTest = (): void => {
  softCache.clear();
  publishedPoliciesByRevision.clear();
  resolvedByLayerKey.clear();
};

/** Test/observability helper — current soft-cache resident key count. */
export const getEffectiveSettingsCacheSizeForTest = (): number => softCache.size;
