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
import { PlatformSettingsModel, type SettingsDraftPolicyMap } from '@/database/models/platform';
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
import { buildSettingsCacheKey, resolveEffectiveSettings } from './effectiveResolver';
import { validateLegacySettingsUpdate } from './legacySettingsCatalog';
import { flattenLeaves, getByPath } from './pathUtils';
import { settingsRegistry } from './registry';

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
const softCache = new Map<string, { at: number; value: EffectiveSettingsResult }>();
const SOFT_CACHE_TTL_MS = 5_000;

/**
 * Narrow transaction lifecycle seam. Production leaves this empty; causal
 * concurrency and rollback tests use promise barriers/fault injection without
 * replacing the service or mirroring its transaction logic.
 */
export interface SettingsMutationLifecycle {
  afterBundleLock?: (operation: 'fullReset' | 'legacyUpdate' | 'patch' | 'reset') => Promise<void>;
  afterManagedWrites?: (operation: 'fullReset' | 'legacyUpdate') => Promise<void>;
  beforeBundleLock?: (operation: 'fullReset' | 'legacyUpdate' | 'patch' | 'reset') => Promise<void>;
  beforeLegacyWrite?: (operation: 'fullReset' | 'legacyUpdate') => Promise<void>;
}

export class EffectiveSettingsService {
  private readonly db: LobeChatDatabase;
  private readonly model: PlatformSettingsModel;
  private readonly invalidation: PlatformConfigInvalidationPublisher;
  private readonly lifecycle: SettingsMutationLifecycle;

  constructor(
    db: LobeChatDatabase,
    invalidation: PlatformConfigInvalidationPublisher = getPlatformConfigInvalidationPublisher(),
    lifecycle: SettingsMutationLifecycle = {},
  ) {
    this.db = db;
    this.model = new PlatformSettingsModel(db);
    this.invalidation = invalidation;
    this.lifecycle = lifecycle;
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

    const bundle = await this.model.getBundle();
    const platformRevision = bundle?.revision ?? 0;
    const published = await this.model.listPublishedPolicies();
    const policies: Record<
      string,
      {
        mode: SettingPolicyMode;
        schemaVersion: number;
        value: unknown;
        visibility: SettingPolicyVisibility;
      }
    > = {};
    for (const row of published) {
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
      platformRevision,
      policies,
      userOverrideRevision: 0,
    });
  };

  /**
   * Resolve effective settings for a user.
   * Flag OFF: pure legacy blob + built-ins (no platform table reads required).
   */
  getEffectiveSettings = async (params: {
    legacyUserSettings?: Record<string, unknown> | null;
    userId: string;
  }): Promise<EffectiveSettingsResult> => {
    const flagOn = this.isPolicyEnabled();

    if (!flagOn) {
      return resolveEffectiveSettings({
        legacyUserSettings: params.legacyUserSettings ?? {},
        platformPolicyEnabled: false,
        platformRevision: 0,
        userOverrideRevision: 0,
      });
    }

    const bundle = await this.model.getBundle();
    const platformRevision = bundle?.revision ?? 0;
    const userOverrideRevision = await this.model.getUserOverrideRevision(params.userId);

    const cacheKey = buildSettingsCacheKey({
      platformRevision,
      registryVersion: settingsRegistry.version,
      userId: params.userId,
      userOverrideRevision,
    });

    const cached = softCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SOFT_CACHE_TTL_MS) {
      return cached.value;
    }

    const published = await this.model.listPublishedPolicies();
    const policies: Record<
      string,
      {
        mode: SettingPolicyMode;
        schemaVersion: number;
        value: unknown;
        visibility: SettingPolicyVisibility;
      }
    > = {};
    for (const row of published) {
      policies[row.path] = {
        mode: row.mode as SettingPolicyMode,
        schemaVersion: row.schemaVersion,
        value: row.value,
        visibility: (row.visibility ?? 'visible') as SettingPolicyVisibility,
      };
    }

    const overrideRows = await this.model.listUserOverrides(params.userId);
    const overrides: Record<string, { value: unknown }> = {};
    for (const row of overrideRows) {
      overrides[row.path] = { value: row.value };
    }

    const result = resolveEffectiveSettings({
      legacyUserSettings: params.legacyUserSettings ?? {},
      overrides,
      platformPolicyEnabled: true,
      platformRevision,
      policies,
      userOverrideRevision,
    });

    softCache.set(cacheKey, { at: Date.now(), value: result });
    return result;
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
    await this.lifecycle.beforeBundleLock?.('patch');
    const { revision } = await this.db.transaction(async (tx) => {
      const model = new PlatformSettingsModel(tx);
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

    await this.lifecycle.beforeBundleLock?.('reset');
    const result = await this.db.transaction(async (tx) => {
      const model = new PlatformSettingsModel(tx);
      await model.lockBundleForUpdate();
      await this.lifecycle.afterBundleLock?.('reset');
      const policy = await model.getPublishedPolicy(params.path);
      if (policy?.mode === 'locked') {
        throw new SettingsPathError(MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN);
      }
      return model.deleteUserOverride(params.userId, params.path, {
        alreadyInTransaction: true,
      });
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

    await this.lifecycle.beforeBundleLock?.('fullReset');
    const revision = await this.db.transaction(async (tx) => {
      const model = new PlatformSettingsModel(tx);
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
    await this.lifecycle.beforeBundleLock?.('legacyUpdate');
    await this.db.transaction(async (tx) => {
      const model = new PlatformSettingsModel(tx);
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
          alreadyInTransaction: true,
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

  /** @deprecated use applyLegacyUpdateSettings */
  adaptLegacyUpdateSettings = async (params: {
    input: Record<string, unknown>;
    userId: string;
  }) => {
    const result = await this.applyLegacyUpdateSettings(params);
    return { appliedPaths: result.appliedPaths, legacyPartial: {} };
  };

  /**
   * Load published policies as a map (for tests / tooling).
   */
  loadPublishedPolicyMap = async (): Promise<SettingsDraftPolicyMap> => {
    if (!this.isPolicyEnabled()) return {};
    const rows = await this.model.listPublishedPolicies();
    const map: SettingsDraftPolicyMap = {};
    for (const row of rows) {
      map[row.path] = {
        mode: row.mode as SettingPolicyMode,
        schemaVersion: row.schemaVersion,
        value: row.value,
        visibility: (row.visibility ?? 'visible') as SettingPolicyVisibility,
      };
    }
    return map;
  };

  private dropUserCache = (userId: string) => {
    for (const key of softCache.keys()) {
      if (key.includes(`:u${userId}:`)) softCache.delete(key);
    }
  };
}

/** Helper for tests / diagnostics — read a leaf from nested settings. */
export const readEffectivePath = (effective: EffectiveSettingsResult, path: string): unknown =>
  effective.effectiveValues[path] ?? getByPath(effective.effectiveSettings, path);
