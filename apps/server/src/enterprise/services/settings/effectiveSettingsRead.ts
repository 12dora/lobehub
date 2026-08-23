import type { PlatformSettingsModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { EffectiveSettingsResult } from '@/types/platform/settings';

import {
  classifyRuntimeMaterializationError,
  type PlatformRuntimeMaterializationReporter,
  reportPlatformRuntimeMaterializationSafely,
} from '../platformInstance/runtimeReporter';
import { buildSettingsCacheKey, resolveEffectiveSettings } from './effectiveResolver';
import { backfillRegisteredLegacyOverrides } from './effectiveSettingsBackfill';
import {
  buildResolvedLayerKey,
  clearAllSettingsCaches,
  legacyCacheChecksum,
  readResolvedLayerCache,
  readSoftCache,
  writeResolvedLayerCache,
  writeSoftCache,
} from './effectiveSettingsCache';
import { materializeUserSettingsLayers } from './effectiveSettingsMaterialize';
import type { SettingsMutationLifecycle } from './effectiveSettingsTypes';
import { settingsRegistry } from './registry';

export function reportSettingsUnavailable(params: {
  db: LobeChatDatabase;
  error: unknown;
  runtimeReporter: PlatformRuntimeMaterializationReporter;
}): void {
  // Force recovery through a new materialization instead of leaving the reporter unavailable
  // while subsequent requests keep serving a pre-failure cache hit at the same revision.
  clearAllSettingsCaches();
  reportPlatformRuntimeMaterializationSafely(params.runtimeReporter, params.db, {
    domain: 'settings',
    errorCategory: classifyRuntimeMaterializationError(params.error),
    health: 'unavailable',
    source: 'unavailable',
  });
}

export interface LoadEffectiveSettingsDeps {
  db: LobeChatDatabase;
  isPolicyEnabled: () => boolean;
  lifecycle: SettingsMutationLifecycle;
  model: PlatformSettingsModel;
  reportUnavailable: (error: unknown) => void;
  runtimeReporter: PlatformRuntimeMaterializationReporter;
}

function userCacheKey(params: {
  legacyChecksum: string;
  platformRevision: number;
  userId: string;
  userOverrideRevision: number;
}): string {
  return buildSettingsCacheKey({
    legacyChecksum: params.legacyChecksum,
    platformRevision: params.platformRevision,
    registryVersion: settingsRegistry.version,
    userId: params.userId,
    userOverrideRevision: params.userOverrideRevision,
  });
}

function resolveWithLayerCache(params: {
  legacyChecksum: string;
  legacyUserSettings: Record<string, unknown>;
  overrides: Record<string, { value: unknown }>;
  platformRevision: number;
  policies: Parameters<typeof resolveEffectiveSettings>[0]['policies'];
  userOverrideRevision: number;
}): EffectiveSettingsResult {
  // Pure resolve is identical for every user at the same platform revision with no
  // overrides and the same legacy checksum — reuse it so multi-user cold fill is
  // dominated by the revision probe, not registry walks.
  const canShareResolved =
    params.userOverrideRevision === 0 && Object.keys(params.overrides).length === 0;
  const layerKey = canShareResolved
    ? buildResolvedLayerKey({
        legacyChecksum: params.legacyChecksum,
        platformRevision: params.platformRevision,
        registryVersion: settingsRegistry.version,
        userOverrideRevision: params.userOverrideRevision,
      })
    : null;
  let result = layerKey ? readResolvedLayerCache(layerKey) : undefined;
  if (!result) {
    result = resolveEffectiveSettings({
      legacyUserSettings: params.legacyUserSettings,
      overrides: params.overrides,
      platformPolicyEnabled: true,
      platformRevision: params.platformRevision,
      policies: params.policies,
      userOverrideRevision: params.userOverrideRevision,
    });
    if (layerKey) writeResolvedLayerCache(layerKey, result);
  }
  return result;
}

type PolicyOnLayers =
  | { hit: EffectiveSettingsResult }
  | {
      miss: {
        legacyChecksum: string;
        overrides: Record<string, { value: unknown }>;
        platformRevision: number;
        policies: Parameters<typeof resolveEffectiveSettings>[0]['policies'];
        userOverrideRevision: number;
      };
    };

async function loadPolicyOnLayers(
  deps: LoadEffectiveSettingsDeps,
  params: { legacyUserSettings: Record<string, unknown>; userId: string },
): Promise<PolicyOnLayers> {
  // Cheap single-statement revision probe for soft-cache hits.
  // On miss, reuse process-local published policies for the platform revision
  // and skip override SELECTs when the user revision token is still 0 (never written).
  let probePlatformRevision: number;
  let probeUserOverrideRevision: number;
  try {
    const probe = await deps.model.getRevisionTokens(params.userId);
    probePlatformRevision = probe.platformRevision;
    probeUserOverrideRevision = probe.userOverrideRevision;
  } catch (error) {
    deps.reportUnavailable(error);
    throw error;
  }

  const legacyChecksum = legacyCacheChecksum(params.legacyUserSettings);
  const cached = readSoftCache(
    userCacheKey({
      legacyChecksum,
      platformRevision: probePlatformRevision,
      userId: params.userId,
      userOverrideRevision: probeUserOverrideRevision,
    }),
  );
  if (cached) return { hit: cached };

  let platformRevision: number;
  let userOverrideRevision: number;
  let policies: Awaited<ReturnType<typeof materializeUserSettingsLayers>>['policies'];
  let overrides: Record<string, { value: unknown }>;
  try {
    const materialised = await materializeUserSettingsLayers({
      model: deps.model,
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
    deps.reportUnavailable(error);
    throw error;
  }

  // One-time migration: copy validated registered legacy leaves into override rows.
  // Idempotent (ON CONFLICT DO NOTHING); never overwrites an existing override.
  try {
    const backfilled = await backfillRegisteredLegacyOverrides({
      db: deps.db,
      legacyUserSettings: params.legacyUserSettings,
      lifecycle: deps.lifecycle,
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
    deps.reportUnavailable(error);
    throw error;
  }

  return {
    miss: {
      legacyChecksum,
      overrides,
      platformRevision,
      policies,
      userOverrideRevision,
    },
  };
}

/**
 * Resolve effective settings for a user.
 * Flag OFF: pure legacy blob + built-ins (no platform table reads required).
 * Flag ON: idempotently backfills registered legacy leaves into override rows,
 * then resolves policy + overrides (+ remaining legacy for unregistered keys).
 */
export async function loadEffectiveSettings(
  deps: LoadEffectiveSettingsDeps,
  params: {
    legacyUserSettings?: Record<string, unknown> | null;
    userId: string;
  },
): Promise<EffectiveSettingsResult> {
  const flagOn = deps.isPolicyEnabled();
  const legacyUserSettings = params.legacyUserSettings ?? {};

  if (!flagOn) {
    return resolveEffectiveSettings({
      legacyUserSettings,
      platformPolicyEnabled: false,
      platformRevision: 0,
      userOverrideRevision: 0,
    });
  }

  const layers = await loadPolicyOnLayers(deps, { legacyUserSettings, userId: params.userId });
  if ('hit' in layers) return layers.hit;

  const result = resolveWithLayerCache({
    legacyChecksum: layers.miss.legacyChecksum,
    legacyUserSettings,
    overrides: layers.miss.overrides,
    platformRevision: layers.miss.platformRevision,
    policies: layers.miss.policies,
    userOverrideRevision: layers.miss.userOverrideRevision,
  });

  // Soft-cache stays per-user (LRU bound); layer memo only skips pure resolve work.
  writeSoftCache(
    userCacheKey({
      legacyChecksum: layers.miss.legacyChecksum,
      platformRevision: layers.miss.platformRevision,
      userId: params.userId,
      userOverrideRevision: layers.miss.userOverrideRevision,
    }),
    result,
  );
  reportPlatformRuntimeMaterializationSafely(deps.runtimeReporter, deps.db, {
    domain: 'settings',
    health: 'healthy',
    revision: layers.miss.platformRevision,
    source: 'database',
  });
  return result;
}
