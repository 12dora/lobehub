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

const RUNTIME_MODE_CACHE_TTL_MS = 30_000;
let runtimeModeSnapshotCache = new WeakMap<
  object,
  {
    expiresAt: number;
    mode: ResolvedManagedResourcePolicies['effectiveModes']['skills'];
  }
>();

/**
 * Readiness is an administrative HEALTH probe: for `aiProviders`/`aiModels` it loads the whole
 * published catalog and resolves (decrypting) every provider secret, and the same probe is
 * registered under both keys. `platform.getCapabilities` is polled by every mounted client, so
 * running it per request would scale secret decryption with (clients x providers).
 *
 * This wrapper is for POLLED, user-facing capability reads only. The admin managed-resources
 * page and the publish guard must keep calling `resolveManagedResourceReadiness` directly so a
 * just-fixed catalog is reflected immediately.
 */
export const MANAGED_RESOURCE_READINESS_CACHE_TTL_MS = 30_000;

let readinessCache: { expiresAt: number; value: ManagedResourceReadinessMap } | null = null;
let readinessInFlight: Promise<ManagedResourceReadinessMap> | null = null;

export const resolveManagedResourceReadinessCached = async (options?: {
  now?: () => number;
  probe?: () => Promise<ManagedResourceReadinessMap>;
}): Promise<ManagedResourceReadinessMap> => {
  const now = options?.now ?? Date.now;
  const at = now();
  if (readinessCache && readinessCache.expiresAt > at) return readinessCache.value;
  // Collapse concurrent polls into a single probe; a rejection is not cached.
  readinessInFlight ??= (options?.probe ?? resolveManagedResourceReadiness)()
    .then((value) => {
      readinessCache = { expiresAt: now() + MANAGED_RESOURCE_READINESS_CACHE_TTL_MS, value };
      return value;
    })
    .finally(() => {
      readinessInFlight = null;
    });
  return readinessInFlight;
};

export const resetManagedResourceReadinessCacheForTest = (): void => {
  readinessCache = null;
  readinessInFlight = null;
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
    // Client/server consistency invariant: the client must block the UI exactly when the
    // server takes over. The server-side takeover predicates read the PUBLISHED policy
    // (`isPlatformAiTakeoverActive` for AI, the Skill runtime for skills), so downgrading
    // `enforced → unmanaged` here on readiness=false would un-hide the settings pages while
    // the runtime is still platform-governed — users would see editable provider/model/skill
    // surfaces whose writes are denied and whose credentials are not theirs. Readiness stays
    // reported separately (`readiness` below) for the admin page, and enforcement can only be
    // published while ready, so the fail-closed reading is the safe one.
    const catalogSafe =
      resource === 'skills' ||
      resource === 'aiProviders' ||
      resource === 'aiModels' ||
      policy.enforcementMode !== 'enforced' ||
      readiness[resource];
    effectiveModes[resource] =
      featureOn && policy.managed && catalogSafe ? policy.enforcementMode : 'unmanaged';
    publicCapabilities[resource] = ['ui-only', 'enforced'].includes(effectiveModes[resource]);
  }

  setManagedSkillRuntimeModeSnapshot(params.db, effectiveModes.skills);

  return { effectiveModes, publicCapabilities, published, readiness, revision: snapshot.revision };
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
  runtimeModeSnapshotCache = new WeakMap();
};
