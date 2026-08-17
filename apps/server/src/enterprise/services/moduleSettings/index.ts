/**
 * Module settings — effective on/off state of platform modules.
 *
 *   - `getModuleSettingsSnapshot()` — hot (30s cached, cross-instance invalidation) view:
 *     env layer + DB row (`platform_module_settings`, id='global').
 *   - `isModuleEnabled(id)` — hot check for request-time gates (tRPC guard, webapi gate,
 *     capabilities, feature-flag derivation).
 *   - `initBootModules()` — awaited once as the first step of `instrumentation.register()`;
 *     freezes the *boot* view used by boot-time facilities (workers, gateway, subprocess).
 *   - `getBootModules()` / `isBootModuleEnabled(id)` — sync; before `initBootModules()`
 *     resolves they reflect env only (never fail closed).
 *   - `getPendingRestartModules()` — restart-kind modules whose effective state differs from
 *     the boot view of *this* process.
 */
import type { EnterpriseCacheDomain } from '@lobechat/observability-otel/modules/enterprise-platform';

import {
  ALL_MODULES_ENABLED,
  computeEffectiveModules,
  matchPreset,
  MODULE_SETTINGS_INVALIDATION_SCOPE,
  MODULE_SETTINGS_SNAPSHOT_TTL_MS,
  PLATFORM_ERROR_CODES,
  type PlatformModuleId,
  type PlatformModulePreset,
  type PlatformModuleStateMap,
  resolveModulesFromEnv,
  RESTART_MODULE_IDS,
} from '@/const/platform';
import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import {
  PlatformModuleSettingsModel,
  type PlatformModuleSettingsRow,
} from '@/database/models/platform/moduleSettings';
import { inTransaction } from '@/database/repositories/platform/tx';
import type { PlatformModuleSettingsMap } from '@/database/schemas/platform/moduleSettings';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { DomainConfigCache, invalidateDomainConfigCacheNamespace } from '../../runtimeConfig';
import {
  getPlatformConfigInvalidationPublisher,
  getPlatformConfigScopeVersion,
} from '../platformConfigInvalidation';

export interface ModuleSettingsSnapshot {
  /** DB overrides (partial); null when the row does not exist. */
  db: Partial<Record<PlatformModuleId, boolean>> | null;
  effective: PlatformModuleStateMap;
  envDisabled: PlatformModuleId[];
  envDisabledBy: Partial<Record<PlatformModuleId, string>>;
  /** Preset that exactly matches `effective`, or null = custom. */
  preset: PlatformModulePreset | null;
  /** Preset selected by env (`LOBE_MODULE_PRESET`), always defined. */
  presetFromEnv: PlatformModulePreset;
  /** CAS revision of the DB row; 0 when the row does not exist. */
  revision: number;
  /** ISO timestamp when the first-run guide was completed; null = show the guide. */
  setupCompletedAt: string | null;
}

export interface AuthoritativeModuleSettingsRow {
  modules: PlatformModuleSettingsMap;
  revision: number;
  setupCompletedAt: Date | null;
}

export interface UpdateModuleSettingsInput {
  actorUserId: string | null;
  /** Prefer the request `ctx.serverDB` so CAS + audit share one connection. */
  db?: LobeChatDatabase | Transaction;
  expectedRevision: number;
  modules: Partial<Record<PlatformModuleId, boolean>>;
  /**
   * Called after the authoritative row is loaded and `expectedRevision` matches,
   * before the write. Use this for compliance reauth so a stale hot snapshot
   * cannot skip the check.
   */
  onAuthoritative?: (row: AuthoritativeModuleSettingsRow) => Promise<void>;
  setupCompleted?: boolean;
  /**
   * Runs inside the same transaction as the CAS write. Throw to roll the
   * settings change back. Invalidation is published only after commit.
   */
  writeAudit?: (
    tx: Transaction,
    before: AuthoritativeModuleSettingsRow,
    after: PlatformModuleSettingsRow,
  ) => Promise<void>;
}

const CACHE_NAMESPACE = 'module_settings';
const CACHE_ID = 'settings';
const cacheKey = {};
const OBSERVABILITY_DOMAIN = 'modules' as EnterpriseCacheDomain;

const resolveEnvLayer = () =>
  resolveModulesFromEnv(process.env, parseEnterpriseFeatureFlags(process.env));

const buildSnapshot = (
  env: ReturnType<typeof resolveEnvLayer>,
  dbModules: Partial<Record<PlatformModuleId, boolean>> | null,
  revision: number,
  setupCompletedAt: string | null,
): ModuleSettingsSnapshot => {
  const effective = computeEffectiveModules(env.envDisabled, dbModules);
  return {
    db: dbModules,
    effective,
    envDisabled: [...env.envDisabled],
    envDisabledBy: env.envDisabledBy,
    preset: matchPreset(effective),
    presetFromEnv: env.preset,
    revision,
    setupCompletedAt,
  };
};

const envOnlySnapshot = (): ModuleSettingsSnapshot =>
  buildSnapshot(resolveEnvLayer(), null, 0, null);

interface DbLayer {
  db: Partial<Record<PlatformModuleId, boolean>> | null;
  revision: number;
  setupCompletedAt: string | null;
}

// Only the DB layer is cached. The env layer (preset / LOBE_MODULES_DISABLED / legacy flags) is
// re-read on every call: it is a handful of env lookups, it never changes in production, and
// reading it live keeps tests that stub env vars honest without cache resets.
const cloneDbLayer = (layer: DbLayer): DbLayer => ({
  db: layer.db ? { ...layer.db } : null,
  revision: layer.revision,
  setupCompletedAt: layer.setupCompletedAt,
});

const NO_DB_LAYER: DbLayer = Object.freeze({ db: null, revision: 0, setupCompletedAt: null });

let cache: DomainConfigCache<DbLayer> | null = null;
let lastLoaded: DbLayer | null = null;
let warnedFailOpen = false;

const warnFailOpen = (error: unknown, lkg: DbLayer | null): void => {
  if (warnedFailOpen) return;
  warnedFailOpen = true;
  console.warn('[module-settings] load failed; serving last-known-good or env fallback', {
    errorClass: error instanceof Error ? error.name : 'UnknownError',
    fallback: lkg ? 'last-known-good' : 'env',
    lastKnownGoodAgeMs: null,
  });
};

const loadDbLayer = async (): Promise<DbLayer> => {
  const db = await getServerDB();
  const row = await new PlatformModuleSettingsModel(db).get();
  const layer: DbLayer = {
    db: row ? row.modules : null,
    revision: row?.revision ?? 0,
    setupCompletedAt: row?.setupCompletedAt ? row.setupCompletedAt.toISOString() : null,
  };
  lastLoaded = layer;
  return layer;
};

const cacheFor = (): DomainConfigCache<DbLayer> => {
  if (cache) return cache;
  cache = new DomainConfigCache<DbLayer>({
    cacheId: CACHE_ID,
    cacheKey,
    cacheTtlMs: MODULE_SETTINGS_SNAPSHOT_TTL_MS,
    cloneValue: cloneDbLayer,
    getScopeEpoch: () => getPlatformConfigScopeVersion(MODULE_SETTINGS_INVALIDATION_SCOPE),
    load: async () => {
      try {
        return await loadDbLayer();
      } catch (error) {
        warnFailOpen(error, lastLoaded);
        const fallback = lastLoaded ?? NO_DB_LAYER;
        lastLoaded = fallback;
        return fallback;
      }
    },
    namespace: CACHE_NAMESPACE,
    observabilityDomain: OBSERVABILITY_DOMAIN,
    onEntryStored: (value) => {
      if (value) lastLoaded = value;
    },
  });
  return cache;
};

const getDbLayer = async (): Promise<DbLayer> => {
  try {
    const layer = await cacheFor().get();
    const resolved = layer ?? lastLoaded ?? NO_DB_LAYER;
    lastLoaded = resolved;
    return resolved;
  } catch (error) {
    warnFailOpen(error, lastLoaded);
    const fallback = lastLoaded ?? NO_DB_LAYER;
    lastLoaded = fallback;
    return fallback;
  }
};

export const getModuleSettingsSnapshot = async (): Promise<ModuleSettingsSnapshot> => {
  const layer = await getDbLayer();
  return buildSnapshot(resolveEnvLayer(), layer.db, layer.revision, layer.setupCompletedAt);
};

export const isModuleEnabled = async (id: PlatformModuleId): Promise<boolean> =>
  (await getModuleSettingsSnapshot()).effective[id];

export const moduleDisabledError = (id: PlatformModuleId) => ({
  code: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
  details: { moduleId: id },
  httpCode: 'FORBIDDEN' as const,
  message: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
});

export const assertModuleEnabled = async (id: PlatformModuleId): Promise<void> => {
  if (!(await isModuleEnabled(id))) {
    throwEnterpriseError(moduleDisabledError(id));
  }
};

const invalidateModuleSettingsSnapshot = (): void => {
  cache?.invalidate();
  invalidateDomainConfigCacheNamespace(CACHE_NAMESPACE);
};

export const publishModuleSettingsInvalidation = async (revision: number): Promise<void> => {
  await getPlatformConfigInvalidationPublisher().publish({
    at: new Date().toISOString(),
    resourceId: 'global',
    resourceType: 'module_settings',
    revision,
    scopes: [MODULE_SETTINGS_INVALIDATION_SCOPE],
  });
  invalidateModuleSettingsSnapshot();
};

const throwRevisionConflict = (error: PlatformRevisionConflictError, expectedRevision: number) =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
    details: {
      currentRevision: error.details?.currentRevision ?? null,
      expectedRevision: error.details?.expectedRevision ?? expectedRevision,
    },
  });

export const updateModuleSettings = async (
  input: UpdateModuleSettingsInput,
): Promise<ModuleSettingsSnapshot> => {
  const db = input.db ?? (await getServerDB());
  const model = new PlatformModuleSettingsModel(db);
  const current = await model.get();
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== input.expectedRevision) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      details: {
        currentRevision,
        expectedRevision: input.expectedRevision,
      },
    });
  }

  const authoritative: AuthoritativeModuleSettingsRow = {
    modules: current?.modules ?? {},
    revision: currentRevision,
    setupCompletedAt: current?.setupCompletedAt ?? null,
  };
  await input.onAuthoritative?.(authoritative);

  const nextModules: PlatformModuleSettingsMap = {
    ...current?.modules,
    ...input.modules,
  };
  const setupCompletedAt =
    input.setupCompleted === true
      ? (current?.setupCompletedAt ?? new Date())
      : input.setupCompleted === false
        ? (current?.setupCompletedAt ?? null)
        : undefined;

  let row: PlatformModuleSettingsRow;
  try {
    row = await inTransaction(db, async (tx) => {
      const written = await new PlatformModuleSettingsModel(tx).upsertWithCas({
        expectedRevision: input.expectedRevision,
        modules: nextModules,
        setupCompletedAt,
        updatedBy: input.actorUserId,
      });
      await input.writeAudit?.(tx, authoritative, written);
      return written;
    });
  } catch (error) {
    if (error instanceof PlatformRevisionConflictError) {
      return throwRevisionConflict(error, input.expectedRevision);
    }
    throw error;
  }

  await publishModuleSettingsInvalidation(row.revision);
  return buildSnapshot(
    resolveEnvLayer(),
    row.modules,
    row.revision,
    row.setupCompletedAt ? row.setupCompletedAt.toISOString() : null,
  );
};

// The boot view lives on `globalThis`, not in a module-level variable: Next.js bundles
// `instrumentation.ts` and each route handler into separate module graphs, so this file can be
// evaluated more than once per process. A module-level slot set by instrumentation would be
// invisible to the tRPC handlers (measured: `pendingRestart` always empty, gateway/start
// answering as if bots were on). One process = one boot view.
const BOOT_MODULES_GLOBAL_KEY = Symbol.for('enterprise.moduleSettings.bootModules');
type BootModulesGlobal = { [BOOT_MODULES_GLOBAL_KEY]?: PlatformModuleStateMap | null };
const bootGlobal = globalThis as unknown as BootModulesGlobal;

const readBootModules = (): PlatformModuleStateMap | null =>
  bootGlobal[BOOT_MODULES_GLOBAL_KEY] ?? null;
const writeBootModules = (value: PlatformModuleStateMap | null): void => {
  bootGlobal[BOOT_MODULES_GLOBAL_KEY] = value;
};

/** First step of instrumentation.register(). Idempotent; failures degrade to env-only. */
export const initBootModules = async (): Promise<PlatformModuleStateMap> => {
  const existing = readBootModules();
  if (existing) return existing;
  let resolved: PlatformModuleStateMap;
  try {
    resolved = (await getModuleSettingsSnapshot()).effective;
  } catch {
    resolved = envOnlySnapshot().effective;
  }
  writeBootModules(resolved);
  return resolved;
};

/** Sync boot view; env-only until `initBootModules()` has resolved (in any module copy). */
export const getBootModules = (): PlatformModuleStateMap =>
  readBootModules() ?? envOnlySnapshot().effective;

export const isBootModuleEnabled = (id: PlatformModuleId): boolean => getBootModules()[id];

export const getPendingRestartModules = async (): Promise<PlatformModuleId[]> => {
  const boot = getBootModules();
  const effective = (await getModuleSettingsSnapshot()).effective;
  return [...RESTART_MODULE_IDS].filter((id) => boot[id] !== effective[id]);
};

/** Test helper. */
export const resetModuleSettingsForTest = (): void => {
  writeBootModules(null);
  cache = null;
  lastLoaded = null;
  warnedFailOpen = false;
  invalidateDomainConfigCacheNamespace(CACHE_NAMESPACE);
};

export { ALL_MODULES_ENABLED };
