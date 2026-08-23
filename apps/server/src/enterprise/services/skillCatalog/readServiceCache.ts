import type { PublishedSkill } from '../../contracts/skillCatalog';
import { invalidateDomainConfigCacheNamespace } from '../../runtimeConfig';
import type { ResolvedSkill } from './resolvedSkill';

export const MAX_READINESS_REVISIONS = 32;
export const MAX_RETAINED_PROJECTION_BYTES = 32 * 1024 * 1024;
export const SKILL_ACTIVE_PROJECTION_CACHE_NAMESPACE = 'skill-catalog-active-projection';

export interface CachedPublishedProjection {
  catalog: { revision: string; skills: PublishedSkill[] };
  executionIndex: ReadonlyMap<string, ResolvedSkill>;
  executionReady: boolean;
  payloadBytes: number;
  targetRevisionId: string;
}

export const readinessByRevision = new Map<string, boolean>();
export const projectionByRevision = new Map<string, CachedPublishedProjection>();
let retainedProjectionBytes = 0;

const sourceIds = new WeakMap<object, number>();
let nextSourceId = 1;

export const getSourceId = (source: object) => {
  const current = sourceIds.get(source);
  if (current) return current;
  const id = nextSourceId++;
  sourceIds.set(source, id);
  return id;
};

export const cloneCatalog = (catalog: CachedPublishedProjection['catalog']) =>
  structuredClone(catalog);

/**
 * Publication is the authority for moving the active projection. Cache entries are immutable and
 * revision-keyed; invalidation only drops the active source pointers so in-flight operations can
 * retain their already captured revision without observing a partially rebuilt projection.
 */
export const invalidatePublishedSkillCatalogReadCache = () => {
  invalidateDomainConfigCacheNamespace(SKILL_ACTIVE_PROJECTION_CACHE_NAMESPACE);
};

export const resetPublishedSkillCatalogReadCacheForTest = () => {
  invalidatePublishedSkillCatalogReadCache();
  projectionByRevision.clear();
  retainedProjectionBytes = 0;
  readinessByRevision.clear();
};

export const cacheReadiness = (revision: string, ready: boolean) => {
  readinessByRevision.delete(revision);
  readinessByRevision.set(revision, ready);
  if (readinessByRevision.size > MAX_READINESS_REVISIONS) {
    const oldest = readinessByRevision.keys().next().value;
    if (oldest) readinessByRevision.delete(oldest);
  }
};

export const storePublishedProjection = (
  projectionKey: string,
  projection: CachedPublishedProjection,
) => {
  const previous = projectionByRevision.get(projectionKey);
  if (previous) retainedProjectionBytes -= previous.payloadBytes;
  projectionByRevision.delete(projectionKey);
  projectionByRevision.set(projectionKey, projection);
  retainedProjectionBytes += projection.payloadBytes;
  while (
    projectionByRevision.size > MAX_READINESS_REVISIONS ||
    retainedProjectionBytes > MAX_RETAINED_PROJECTION_BYTES
  ) {
    const oldest = projectionByRevision.keys().next().value;
    if (!oldest) break;
    const evicted = projectionByRevision.get(oldest);
    projectionByRevision.delete(oldest);
    if (evicted) retainedProjectionBytes -= evicted.payloadBytes;
  }
};
