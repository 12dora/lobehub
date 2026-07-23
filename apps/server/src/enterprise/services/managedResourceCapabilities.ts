import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import {
  MANAGED_RESOURCE_KINDS,
  type ManagedResourceKind,
} from '@/const/platform/managedResources';
import {
  createUnmanagedResourcePolicyMap,
  isManagedResourceFeatureEnabled,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { ManagedResourcesCapabilities } from '@/types/platform/capabilities';
import type {
  ManagedResourcePolicyMap,
  ManagedResourceReadinessMap,
} from '@/types/platform/managedResources';

import { resolveManagedResourceReadiness } from './managedResourceReadiness';
import { getPlatformConfigScopeVersion } from './platformConfigInvalidation';

const RUNTIME_MODE_CACHE_TTL_MS = 30_000;
const runtimeModeCache = new Map<
  number,
  {
    epoch: string;
    expiresAt: number;
    mode: ResolvedManagedResourcePolicies['effectiveModes']['skills'];
  }
>();
let runtimeModeSnapshotCache = new WeakMap<
  object,
  {
    expiresAt: number;
    mode: ResolvedManagedResourcePolicies['effectiveModes']['skills'];
  }
>();
const runtimeModeSourceIds = new WeakMap<object, number>();
let nextRuntimeModeSourceId = 1;

const getRuntimeModeSourceId = (source: object) => {
  const cached = runtimeModeSourceIds.get(source);
  if (cached) return cached;
  const id = nextRuntimeModeSourceId++;
  runtimeModeSourceIds.set(source, id);
  return id;
};

export interface ResolvedManagedResourcePolicies {
  effectiveModes: Record<ManagedResourceKind, 'unmanaged' | 'observe' | 'ui-only' | 'enforced'>;
  publicCapabilities: ManagedResourcesCapabilities;
  published: ManagedResourcePolicyMap;
  readiness: ManagedResourceReadinessMap;
  revision: number;
}

const setManagedSkillRuntimeModeSnapshot = (
  db: LobeChatDatabase,
  mode: ResolvedManagedResourcePolicies['effectiveModes']['skills'],
  expiresAt = Date.now() + RUNTIME_MODE_CACHE_TTL_MS,
) => {
  runtimeModeSnapshotCache.set(db as object, { expiresAt, mode });
};

export const resolvePublishedManagedResourcePolicies = async (params: {
  db: LobeChatDatabase;
  flags: EnterpriseFeatureFlags;
  readiness?: () => Promise<ManagedResourceReadinessMap>;
}): Promise<ResolvedManagedResourcePolicies> => {
  const [snapshot, readiness] = await Promise.all([
    new PlatformManagedResourcePolicyModel(params.db).getSnapshot(),
    (params.readiness ?? resolveManagedResourceReadiness)(),
  ]);
  const published =
    snapshot.status === 'published' ? snapshot.published : createUnmanagedResourcePolicyMap();
  const publicCapabilities = {} as ManagedResourcesCapabilities;
  const effectiveModes = {} as ResolvedManagedResourcePolicies['effectiveModes'];

  for (const resource of MANAGED_RESOURCE_KINDS) {
    const policy = published[resource];
    const featureOn = isManagedResourceFeatureEnabled(resource, params.flags);
    // Skills must never fall back to legacy writes/runtime after enforcement was
    // published. Readiness is reported separately and the runtime fails closed;
    // silently changing the effective mode to unmanaged would reopen personal
    // mutation and name-based execution paths during a catalog outage.
    const catalogSafe =
      resource === 'skills' || policy.enforcementMode !== 'enforced' || readiness[resource];
    effectiveModes[resource] =
      featureOn && policy.managed && catalogSafe ? policy.enforcementMode : 'unmanaged';
    publicCapabilities[resource] = ['ui-only', 'enforced'].includes(effectiveModes[resource]);
  }

  setManagedSkillRuntimeModeSnapshot(params.db, effectiveModes.skills);

  return { effectiveModes, publicCapabilities, published, readiness, revision: snapshot.revision };
};

/**
 * Resolve the trusted Skill runtime mode without touching catalog/readiness.
 * Warm operations read only the shared invalidation epoch; policy DB reads are
 * bounded by the epoch plus TTL and the resulting mode is frozen into the
 * operation context before runtime adapters execute.
 */
export const resolveManagedSkillRuntimeMode = async (params: {
  db: LobeChatDatabase;
  flags: EnterpriseFeatureFlags;
  options?: {
    cacheTtlMs?: number;
    getCacheEpoch?: () => Promise<string>;
    model?: Pick<PlatformManagedResourcePolicyModel, 'getSnapshot'>;
    now?: () => number;
  };
}): Promise<ResolvedManagedResourcePolicies['effectiveModes']['skills']> => {
  if (!params.flags.ENABLE_PLATFORM_MANAGED_SKILLS) return 'unmanaged';
  const source = params.options?.model ?? params.db;
  const sourceId = getRuntimeModeSourceId(source as object);
  const now = params.options?.now?.() ?? Date.now();
  const epoch = await (
    params.options?.getCacheEpoch ?? (() => getPlatformConfigScopeVersion('managed-policy'))
  )().catch(() => 'unavailable');
  const cached = runtimeModeCache.get(sourceId);
  if (cached && cached.epoch === epoch && cached.expiresAt > now) {
    setManagedSkillRuntimeModeSnapshot(params.db, cached.mode, cached.expiresAt);
    return cached.mode;
  }

  const snapshot = await (
    params.options?.model ?? new PlatformManagedResourcePolicyModel(params.db)
  ).getSnapshot();
  const policy = snapshot.published.skills;
  const mode =
    snapshot.status === 'published' && policy.managed ? policy.enforcementMode : 'unmanaged';
  runtimeModeCache.set(sourceId, {
    epoch,
    expiresAt: now + (params.options?.cacheTtlMs ?? RUNTIME_MODE_CACHE_TTL_MS),
    mode,
  });
  setManagedSkillRuntimeModeSnapshot(
    params.db,
    mode,
    now + (params.options?.cacheTtlMs ?? RUNTIME_MODE_CACHE_TTL_MS),
  );
  return mode;
};

/**
 * Synchronous runtime read for hot tool paths. The snapshot is populated only
 * by the trusted policy resolver above; feature-on cache misses and expired
 * snapshots fail closed until a non-hot operation refreshes them.
 */
export const getManagedSkillRuntimeModeSnapshot = (params: {
  db: LobeChatDatabase;
  flags: EnterpriseFeatureFlags;
  now?: () => number;
}): ResolvedManagedResourcePolicies['effectiveModes']['skills'] => {
  if (!params.flags.ENABLE_PLATFORM_MANAGED_SKILLS) return 'unmanaged';
  const cached = runtimeModeSnapshotCache.get(params.db as object);
  if (!cached || cached.expiresAt <= (params.now?.() ?? Date.now())) return 'enforced';
  return cached.mode;
};

export const resetManagedSkillRuntimeModeCacheForTest = () => {
  runtimeModeCache.clear();
  runtimeModeSnapshotCache = new WeakMap();
};
