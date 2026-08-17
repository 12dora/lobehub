/**
 * Process-local settings caches (soft result, published policies, resolved layers).
 * Not a multi-instance guarantee — invalidation is best-effort via the publisher.
 */

import { checksumPayload } from '@/database/models/platform';
import type {
  EffectiveSettingsResult,
  SettingPolicyMode,
  SettingPolicyVisibility,
} from '@/types/platform/settings';

/** Drop secrets and normalize empty legacy for cache keys. */
export const sanitizeLegacyForCache = (
  legacy: Record<string, unknown> | null | undefined,
): Record<string, unknown> => {
  if (!legacy) return {};
  const { keyVaults: _keyVaults, ...rest } = legacy;
  return rest;
};

export const legacyCacheChecksum = (legacy: Record<string, unknown> | null | undefined): string =>
  checksumPayload(sanitizeLegacyForCache(legacy));

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
export type PublishedPolicyMap = Record<
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

export const readPublishedPoliciesCache = (
  platformRevision: number,
): PublishedPolicyMap | undefined => {
  const cached = publishedPoliciesByRevision.get(platformRevision);
  if (!cached) return undefined;
  // Refresh LRU insertion order.
  publishedPoliciesByRevision.delete(platformRevision);
  publishedPoliciesByRevision.set(platformRevision, cached);
  return cached;
};

export const writePublishedPoliciesCache = (
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

export const buildResolvedLayerKey = (params: {
  legacyChecksum: string;
  platformRevision: number;
  registryVersion: number;
  userOverrideRevision: number;
}): string =>
  `r${params.registryVersion}:p${params.platformRevision}:o${params.userOverrideRevision}:l${params.legacyChecksum}`;

export const readResolvedLayerCache = (key: string): EffectiveSettingsResult | undefined => {
  const cached = resolvedByLayerKey.get(key);
  if (!cached) return undefined;
  resolvedByLayerKey.delete(key);
  resolvedByLayerKey.set(key, cached);
  return cached;
};

export const writeResolvedLayerCache = (key: string, value: EffectiveSettingsResult): void => {
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

export const readSoftCache = (key: string): EffectiveSettingsResult | undefined => {
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

export const writeSoftCache = (key: string, value: EffectiveSettingsResult): void => {
  const now = Date.now();
  softCache.delete(key);
  softCache.set(key, { expiresAt: now + SOFT_CACHE_TTL_MS, value });
  pruneSoftCache(now);
};

export const dropUserCache = (userId: string): void => {
  for (const key of softCache.keys()) {
    if (key.includes(`:u${userId}:`)) softCache.delete(key);
  }
};

export const clearAllSettingsCaches = (): void => {
  softCache.clear();
  publishedPoliciesByRevision.clear();
  resolvedByLayerKey.clear();
};

export const settingsSoftCacheSize = (): number => softCache.size;
