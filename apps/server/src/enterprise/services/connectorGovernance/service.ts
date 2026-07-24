import type { LobeChatDatabase } from '@lobechat/database';

import {
  PlatformConnectorGovernanceModel,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { getPlatformConfigScopeVersion } from '../platformConfigInvalidation';
import type { ResolvedConnectorGovernance } from './types';

/**
 * Invalidation scope bumped on every governance publish. The resolver cache
 * epoch also folds in `managed-policy` because `active` depends on the
 * connectors managed-resource policy.
 */
export const CONNECTOR_GOVERNANCE_INVALIDATION_SCOPE = 'connector-governance';

const CACHE_TTL_MS = 30_000;

const resolvedCache = new Map<
  number,
  { epoch: string; expiresAt: number; resolved: ResolvedConnectorGovernance }
>();
/**
 * Last successfully resolved snapshot per source (diagnostic / process cache).
 * Epoch is retained so helpers can reason about staleness. The public
 * `resolveConnectorGovernance` path never restores this on read failure —
 * same-epoch LKG can predate a committed restrictive publish whose invalidation
 * was lost.
 */
const lastKnownGoodCache = new Map<
  number,
  { epoch: string; resolved: ResolvedConnectorGovernance }
>();
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 1;

const getSourceId = (source: object): number => {
  const cached = sourceIds.get(source);
  if (cached) return cached;
  const id = nextSourceId++;
  sourceIds.set(source, id);
  return id;
};

const readCacheEpoch = async (): Promise<string> => {
  const [policyEpoch, governanceEpoch] = await Promise.all([
    getPlatformConfigScopeVersion('managed-policy'),
    getPlatformConfigScopeVersion(CONNECTOR_GOVERNANCE_INVALIDATION_SCOPE),
  ]);
  return `${policyEpoch}:${governanceEpoch}`;
};

export interface ResolveConnectorGovernanceOptions {
  cacheTtlMs?: number;
  env?: Record<string, string | undefined>;
  getCacheEpoch?: () => Promise<string>;
  now?: () => number;
}

/**
 * Published org connector governance, cached on the shared invalidation epoch
 * (managed-policy + connector-governance scopes) plus a bounded TTL — the same
 * pattern as the managed-resource runtime-mode resolver.
 *
 * `active` mirrors the effective-enforced connectors policy (feature flag +
 * managed + enforcementMode === 'enforced'). The builtin tool policy matrix is
 * returned regardless; `active === false` means runtime consumers ignore it.
 */
export const resolvePublishedConnectorGovernance = async (
  db: LobeChatDatabase,
  options: ResolveConnectorGovernanceOptions = {},
): Promise<ResolvedConnectorGovernance> => {
  const sourceId = getSourceId(db as object);
  const now = options.now?.() ?? Date.now();
  // Epoch read failure → do not invent a synthetic cache key. Serve a live
  // resolve without caching so we never pin policy under "unavailable".
  let epoch: string | null;
  try {
    epoch = await (options.getCacheEpoch ?? readCacheEpoch)();
    if (!epoch || epoch === 'unavailable') epoch = null;
  } catch {
    epoch = null;
  }
  if (epoch) {
    const cached = resolvedCache.get(sourceId);
    if (cached && cached.epoch === epoch && cached.expiresAt > now) return cached.resolved;
  }

  const flags = parseEnterpriseFeatureFlags(options.env ?? process.env);
  const [policySnapshot, governance] = await Promise.all([
    new PlatformManagedResourcePolicyModel(db).getSnapshot(),
    new PlatformConnectorGovernanceModel(db).getOrCreate(),
  ]);
  const policy = policySnapshot.published.connectors;
  const active =
    flags.ENABLE_PLATFORM_MANAGED_CONNECTORS &&
    policySnapshot.status === 'published' &&
    policy.managed &&
    policy.enforcementMode === 'enforced';

  const resolved: ResolvedConnectorGovernance = {
    active,
    builtinToolPolicies: governance.published.builtinToolPolicies,
    sharedAuthOwnerUserId: active ? governance.published.sharedAuthorization.ownerUserId : null,
  };
  // Only cache + LKG under a real invalidation epoch. Synthetic/missing epochs
  // must not retain policy that later restrictive publishes cannot invalidate.
  if (epoch) {
    resolvedCache.set(sourceId, {
      epoch,
      expiresAt: now + (options.cacheTtlMs ?? CACHE_TTL_MS),
      resolved,
    });
    lastKnownGoodCache.set(sourceId, { epoch, resolved });
  }
  return resolved;
};

/** Process-local last-known-good snapshot (diagnostic; may be stale). */
export const getLastKnownConnectorGovernance = (
  db: LobeChatDatabase,
): ResolvedConnectorGovernance | null => {
  const sourceId = getSourceId(db as object);
  return lastKnownGoodCache.get(sourceId)?.resolved ?? null;
};

/** Test/diagnostic: epoch that produced the retained LKG, if any. */
export const getLastKnownConnectorGovernanceEpoch = (db: LobeChatDatabase): string | null => {
  const sourceId = getSourceId(db as object);
  return lastKnownGoodCache.get(sourceId)?.epoch ?? null;
};

/**
 * Return LKG only when its stored invalidation epoch still matches the live
 * epoch. Diagnostic helper — public resolve does not use this for fail-open.
 */
export const getLastKnownConnectorGovernanceIfCurrent = async (
  db: LobeChatDatabase,
  options: ResolveConnectorGovernanceOptions = {},
): Promise<ResolvedConnectorGovernance | null> => {
  const sourceId = getSourceId(db as object);
  const lkg = lastKnownGoodCache.get(sourceId);
  if (!lkg || lkg.epoch === 'unavailable') return null;
  try {
    const epoch = await (options.getCacheEpoch ?? readCacheEpoch)();
    if (!epoch || epoch === 'unavailable' || epoch !== lkg.epoch) return null;
    return lkg.resolved;
  } catch {
    return null;
  }
};

export const resetConnectorGovernanceCacheForTest = () => {
  resolvedCache.clear();
  lastKnownGoodCache.clear();
};
