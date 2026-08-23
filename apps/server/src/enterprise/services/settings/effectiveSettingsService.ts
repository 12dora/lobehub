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
import { PlatformSettingsModel } from '@/database/models/platform';
import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';
import type { EffectiveSettingsResult, SettingClientSurface } from '@/types/platform/settings';

import { getEnterpriseFeatureFlags } from '../../featureFlags';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import {
  type PlatformRuntimeMaterializationReporter,
  reportPlatformRuntimeMaterialization,
} from '../platformInstance/runtimeReporter';
import { resolveEffectiveSettings } from './effectiveResolver';
import {
  clearAllSettingsCaches,
  dropUserCache,
  settingsSoftCacheSize,
} from './effectiveSettingsCache';
import { SettingsPathError } from './effectiveSettingsErrors';
import { collectLegacyOverrideOps } from './effectiveSettingsLegacyOps';
import { publishedRowsToPolicyMap } from './effectiveSettingsMaps';
import { loadEffectiveSettings, reportSettingsUnavailable } from './effectiveSettingsRead';
import type { SettingsMutationLifecycle } from './effectiveSettingsTypes';
import { validateLegacySettingsUpdate } from './legacySettingsCatalog';
import { buildLegacySettingsPartial } from './legacySettingsPartial';
import { deleteByPath } from './pathUtils';
import { settingsRegistry } from './registry';

export { SettingsPathError } from './effectiveSettingsErrors';
export type { SettingsMutationLifecycle } from './effectiveSettingsTypes';

// Re-export codes for call sites
export { MANAGED_ERROR_CODES, PLATFORM_ERROR_CODES };

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

    return resolveEffectiveSettings({
      legacyUserSettings: {},
      overrides: {},
      platformPolicyEnabled: true,
      platformRevision: snapshot.platformRevision,
      policies: publishedRowsToPolicyMap(snapshot.published),
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
  }): Promise<EffectiveSettingsResult> =>
    loadEffectiveSettings(
      {
        db: this.db,
        isPolicyEnabled: this.isPolicyEnabled,
        lifecycle: this.lifecycle,
        model: this.model,
        reportUnavailable: this.reportUnavailable,
        runtimeReporter: this.runtimeReporter,
      },
      params,
    );

  private reportUnavailable = (error: unknown): void => {
    reportSettingsUnavailable({
      db: this.db,
      error,
      runtimeReporter: this.runtimeReporter,
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

    dropUserCache(params.userId);
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

    dropUserCache(params.userId);
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

    dropUserCache(params.userId);
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
    const ops = collectLegacyOverrideOps(validatedInput);

    // Build legacy partial (non-registered known leaves + hotkey etc.)
    const legacyPartial = buildLegacySettingsPartial(validatedInput, settingsRegistry);

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

    dropUserCache(params.userId);
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
}

export const resetEffectiveSettingsCacheForTest = (): void => {
  clearAllSettingsCaches();
};

/** Test/observability helper — current soft-cache resident key count. */
export const getEffectiveSettingsCacheSizeForTest = (): number => settingsSoftCacheSize();
