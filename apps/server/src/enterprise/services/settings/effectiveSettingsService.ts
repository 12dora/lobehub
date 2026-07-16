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

export class EffectiveSettingsService {
  private readonly model: PlatformSettingsModel;
  private readonly invalidation: PlatformConfigInvalidationPublisher;

  constructor(
    db: LobeChatDatabase,
    invalidation: PlatformConfigInvalidationPublisher = getPlatformConfigInvalidationPublisher(),
  ) {
    this.model = new PlatformSettingsModel(db);
    this.invalidation = invalidation;
  }

  isPolicyEnabled = (): boolean => getEnterpriseFeatureFlags().ENABLE_PLATFORM_SETTINGS_POLICY;

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
    client?: SettingClientSurface;
    path: string;
    userId: string;
    value: unknown;
  }) => {
    if (!this.isPolicyEnabled()) {
      throw new SettingsPathError(PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED);
    }

    const gate = settingsRegistry.assertPathWritable({
      client: params.client,
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

    const policy = await this.model.getPublishedPolicy(params.path);
    if (policy?.mode === 'locked') {
      throw new SettingsPathError(MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN);
    }
    // visibility=hidden does NOT reject by itself

    const { revision } = await this.model.upsertUserOverride({
      path: params.path,
      userId: params.userId,
      value: validated.value,
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

  resetSettingOverride = async (params: { path: string; userId: string }) => {
    if (!this.isPolicyEnabled()) {
      throw new SettingsPathError(PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED);
    }

    const gate = settingsRegistry.assertPathWritable({ path: params.path });
    if (gate) throw new SettingsPathError(gate);

    const policy = await this.model.getPublishedPolicy(params.path);
    if (policy?.mode === 'locked') {
      throw new SettingsPathError(MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN);
    }

    // Delete exactly this path — no other settings
    const { deleted, revision } = await this.model.deleteUserOverride(params.userId, params.path);

    this.dropUserCache(params.userId);
    await this.invalidation.publish({
      at: new Date().toISOString(),
      resourceId: params.userId,
      resourceType: 'settings',
      revision,
      scopes: ['settings', `user:${params.userId}`],
    });

    return { deleted, path: params.path, revision };
  };

  /**
   * Legacy updateSettings adapter when flag is ON.
   *
   * 1. Flatten only registered non-secret paths from the request
   * 2. Validate the entire request first
   * 3. Reject locked / unknown / wrong-type before any write
   * 4. Apply all registered path overrides atomically
   * 5. Return remaining unregistered non-secret partial for legacy user_settings merge
   *
   * keyVaults is never copied into overrides — caller handles encrypted path separately.
   */
  adaptLegacyUpdateSettings = async (params: {
    input: Record<string, unknown>;
    userId: string;
  }): Promise<{
    /** Registered path overrides applied (or would apply). */
    appliedPaths: string[];
    /** Partial to still write to legacy user_settings (unregistered + non-secret). */
    legacyPartial: Record<string, unknown>;
  }> => {
    if (!this.isPolicyEnabled()) {
      // Flag OFF: no adaptation — caller keeps full input for legacy path
      const { keyVaults: _kv, ...rest } = params.input;
      return { appliedPaths: [], legacyPartial: rest };
    }

    const leaves = flattenLeaves(params.input);
    const ops: Array<{ path: string; value: unknown }> = [];
    const rejected: SettingsPathError[] = [];

    for (const leaf of leaves) {
      const { path, value } = leaf;

      // keyVaults / secrets never enter override table
      if (settingsRegistry.isSecretPath(path)) {
        continue;
      }

      if (!settingsRegistry.has(path)) {
        // Unregistered non-secret leaves stay in legacy blob (compat)
        continue;
      }

      const gate = settingsRegistry.assertPathWritable({ path });
      if (gate) {
        rejected.push(new SettingsPathError(gate));
        continue;
      }

      const validated = settingsRegistry.validateValue(path, value);
      if (!validated.ok) {
        rejected.push(
          new SettingsPathError(
            MANAGED_ERROR_CODES.MANAGED_SETTING_INVALID_VALUE,
            validated.message,
          ),
        );
        continue;
      }

      const policy = await this.model.getPublishedPolicy(path);
      if (policy?.mode === 'locked') {
        rejected.push(new SettingsPathError(MANAGED_ERROR_CODES.MANAGED_SETTING_BY_ADMIN));
        continue;
      }

      ops.push({ path, value: validated.value });
    }

    // Fail closed — no partial writes
    if (rejected.length > 0) {
      throw rejected[0];
    }

    if (ops.length > 0) {
      const revision = await this.model.upsertUserOverridesBatch({
        ops,
        userId: params.userId,
      });
      this.dropUserCache(params.userId);
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: params.userId,
        resourceType: 'settings',
        revision,
        scopes: ['settings', `user:${params.userId}`],
      });
    }

    // Legacy partial: only unregistered top-level keys (minus secrets handled by caller)
    // Registered leaves are already in overrides; strip them from legacy write to avoid dual source.
    // For simplicity keep non-registered top-level groups intact if they have no registered leaves
    // actually applied — but strip keyVaults (caller encrypts).
    const registeredPaths = new Set(ops.map((o) => o.path));
    const legacyPartial: Record<string, unknown> = {};

    for (const [topKey, topVal] of Object.entries(params.input)) {
      if (topKey === 'keyVaults') continue;
      if (settingsRegistry.isSecretPath(topKey)) continue;

      // If any registered leaf under this top key was applied, rebuild without those leaves
      // is expensive; for compat we still write unregistered-only leaf leftovers via omit.
      // Strategy: if top-level is entirely unregistered, keep as-is; else omit registered leaves.
      const topRegistered = settingsRegistry
        .paths()
        .some((p) => p === topKey || p.startsWith(`${topKey}.`));
      if (!topRegistered) {
        legacyPartial[topKey] = topVal;
        continue;
      }

      // Drop registered leaves from nested object by not including pure registered subtrees
      // Unregistered siblings under same parent (rare) preserved via flatten/rebuild:
      const nestedLeaves = flattenLeaves(topVal, topKey);
      const unregistered = nestedLeaves.filter((l) => !settingsRegistry.has(l.path));
      if (unregistered.length === 0) continue;

      // Rebuild a partial tree for unregistered leaves only
      let partial: Record<string, unknown> = {};
      for (const leaf of unregistered) {
        // relative path under topKey
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
      if (Object.keys(partial).length > 0) {
        legacyPartial[topKey] = partial;
      }
    }

    void registeredPaths; // used for clarity / future
    return { appliedPaths: ops.map((o) => o.path), legacyPartial };
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
