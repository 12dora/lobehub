import { createHash } from 'node:crypto';

import { PlatformContentModerationSettingsModel } from '@/database/models/platform/contentModerationSettings';
import type { LobeChatDatabase } from '@/database/type';
import {
  DomainConfigCache,
  invalidateDomainConfigCacheNamespace,
} from '@/server/enterprise/runtimeConfig';
import { getPlatformConfigScopeVersion } from '@/server/enterprise/services/platformConfigInvalidation';
import type { ContentModerationConfig } from '@/types/platform/contentModeration';
import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import {
  MODERATION_SNAPSHOT_CACHE_NAMESPACE,
  MODERATION_SNAPSHOT_CACHE_SCOPE,
  MODERATION_SNAPSHOT_CACHE_TTL_MS,
} from './constants';
import { type CompiledKeywordMatcher, compileKeywordMatcher } from './keywordMatcher';

export interface ModerationSnapshot {
  config: ContentModerationConfig;
  digest: string;
  exemptRoles: Set<string>;
  exemptUserIds: Set<string>;
  matcher: CompiledKeywordMatcher;
  modelScope: ContentModerationConfig['scope']['modelFilter'];
  revision: number;
  updatedAt: Date | null;
}

const digestConfig = (config: ContentModerationConfig): string =>
  createHash('sha256').update(JSON.stringify(config)).digest('hex');

let compiledByDigest = new Map<string, CompiledKeywordMatcher>();

const matcherFor = (config: ContentModerationConfig, digest: string): CompiledKeywordMatcher => {
  const existing = compiledByDigest.get(digest);
  if (existing) return existing;
  const matcher = compileKeywordMatcher(config.keywords);
  compiledByDigest.set(digest, matcher);
  if (compiledByDigest.size > 8) {
    const first = compiledByDigest.keys().next().value;
    if (first) compiledByDigest.delete(first);
  }
  return matcher;
};

const toSnapshot = (
  config: ContentModerationConfig,
  revision: number,
  updatedAt: Date | null,
): ModerationSnapshot => {
  const digest = digestConfig(config);
  return {
    config,
    digest,
    exemptRoles: new Set(config.scope.exemptRoles),
    exemptUserIds: new Set(config.scope.exemptUserIds),
    matcher: matcherFor(config, digest),
    modelScope: config.scope.modelFilter,
    revision,
    updatedAt,
  };
};

const cloneSnapshot = (snapshot: ModerationSnapshot): ModerationSnapshot => ({
  config: structuredClone(snapshot.config),
  digest: snapshot.digest,
  exemptRoles: new Set(snapshot.exemptRoles),
  exemptUserIds: new Set(snapshot.exemptUserIds),
  matcher: snapshot.matcher,
  modelScope: snapshot.config.scope.modelFilter,
  revision: snapshot.revision,
  updatedAt: snapshot.updatedAt,
});

let caches = new WeakMap<object, DomainConfigCache<ModerationSnapshot>>();
let lastKnownGood = new WeakMap<object, ModerationSnapshot>();

const defaultSnapshot = () => toSnapshot(createDefaultContentModerationConfig(), 0, null);

const cacheFor = (db: LobeChatDatabase): DomainConfigCache<ModerationSnapshot> => {
  const existing = caches.get(db);
  if (existing) return existing;
  const cache = new DomainConfigCache<ModerationSnapshot>({
    cacheId: 'settings',
    cacheKey: db,
    cacheTtlMs: MODERATION_SNAPSHOT_CACHE_TTL_MS,
    cloneValue: cloneSnapshot,
    getScopeEpoch: () => getPlatformConfigScopeVersion(MODERATION_SNAPSHOT_CACHE_SCOPE),
    load: async () => {
      try {
        const row = await new PlatformContentModerationSettingsModel(db).get();
        const snapshot = row
          ? toSnapshot(row.config, row.revision, row.updatedAt)
          : defaultSnapshot();
        lastKnownGood.set(db, snapshot);
        return snapshot;
      } catch (error) {
        console.error(
          '[content-moderation] settings load failed; serving last-known-good or default',
          {
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          },
        );
        return lastKnownGood.get(db) ?? defaultSnapshot();
      }
    },
    namespace: MODERATION_SNAPSHOT_CACHE_NAMESPACE,
    observabilityDomain: 'moderation',
  });
  caches.set(db, cache);
  return cache;
};

export const getModerationSnapshot = async (db: LobeChatDatabase): Promise<ModerationSnapshot> => {
  try {
    const snapshot = await cacheFor(db).get();
    return snapshot ?? lastKnownGood.get(db) ?? defaultSnapshot();
  } catch (error) {
    console.error(
      '[content-moderation] settings cache failed; serving last-known-good or default',
      {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      },
    );
    return lastKnownGood.get(db) ?? defaultSnapshot();
  }
};

export const invalidateModerationSnapshot = (db?: LobeChatDatabase): void => {
  if (db) caches.get(db)?.invalidate();
  invalidateDomainConfigCacheNamespace(MODERATION_SNAPSHOT_CACHE_NAMESPACE);
};

export const resetModerationSnapshotForTest = (): void => {
  compiledByDigest = new Map();
  caches = new WeakMap();
  lastKnownGood = new WeakMap();
};
