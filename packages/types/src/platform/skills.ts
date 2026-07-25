import type { AgentPluginMode } from '../agent/pluginConfig';
import type { SkillListItem, SkillResourceContent } from '../skill';

export const PLATFORM_SKILL_DISTRIBUTIONS = ['mandatory', 'default', 'optional'] as const;
export type PlatformSkillDistribution = (typeof PLATFORM_SKILL_DISTRIBUTIONS)[number];

/** Operation-scoped runtime id prefix shared by client and server adapters. */
export const PLATFORM_SKILL_ID_PREFIX = 'platform-skill:';

/** Bounded in-flight / settled resolution cache size for operation-scoped skill adapters. */
export const PLATFORM_SKILL_RESOLUTION_CACHE_LIMIT = 128;

/** Canonical runtime id for an exact pinned skill ref. */
export const platformSkillRuntimeId = (ref: {
  checksum: string;
  skillKey: string;
  version: string;
}): string => `${PLATFORM_SKILL_ID_PREFIX}${ref.skillKey}@${ref.version}#${ref.checksum}`;

/** Project a pinned ref (+ optional public metadata) into a SkillListItem. */
export const toPlatformSkillListItem = (
  ref: PlatformSkillPinnedRef,
  metadata?: { description?: string | null; displayName?: string },
): SkillListItem => ({
  createdAt: new Date(0),
  description: metadata?.description ?? '',
  id: platformSkillRuntimeId(ref),
  identifier: ref.skillKey,
  manifest: { description: metadata?.description ?? '', name: ref.skillKey, version: ref.version },
  name: metadata?.displayName ?? ref.skillKey,
  source: 'user',
  updatedAt: new Date(0),
});

/**
 * Project a resolved resource blob into the shared SkillResourceContent envelope.
 * Callers own the miss/error message — the server adapter redacts the path by policy;
 * client adapters may include it for operator debugging.
 */
export const toPlatformSkillResourceContent = (
  path: string,
  resource: { content: string; fileHash: string; size: number },
): SkillResourceContent => ({
  content: resource.content,
  encoding: 'utf8',
  fileHash: resource.fileHash,
  fileType: 'text/plain',
  path,
  size: resource.size,
});

/** Index exact refs by skillKey and by runtime id for O(1) operation-scoped lookup. */
export const indexPlatformSkillRefs = (refs: readonly PlatformSkillPinnedRef[]) => {
  const byKey = new Map<string, PlatformSkillPinnedRef>();
  const byId = new Map<string, PlatformSkillPinnedRef>();
  for (const ref of refs) {
    byKey.set(ref.skillKey, ref);
    byId.set(platformSkillRuntimeId(ref), ref);
  }
  return { byId, byKey };
};

/**
 * In-flight promise cache that coalesces concurrent lookups and evicts rejections so a
 * transient resolution failure does not poison later calls for the same key.
 */
export class PlatformSkillInFlightCache<T> {
  private readonly cache = new Map<string, Promise<T>>();

  constructor(private readonly limit = PLATFORM_SKILL_RESOLUTION_CACHE_LIMIT) {}

  get(key: string): Promise<T> | undefined {
    return this.cache.get(key);
  }

  set(key: string, pending: Promise<T>): Promise<T> {
    if (this.cache.size >= this.limit && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    const tracked = pending.catch((error: unknown) => {
      if (this.cache.get(key) === tracked) this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, tracked);
    return tracked;
  }

  get size() {
    return this.cache.size;
  }
}

export interface PlatformPublishedSkill {
  checksum: string;
  description: string | null;
  displayName: string;
  distribution: PlatformSkillDistribution;
  skillKey: string;
  source: 'builtin' | 'uploaded';
  version: string;
}

export interface PlatformPublishedSkillCatalog {
  revision: string;
  skills: PlatformPublishedSkill[];
}

export interface PlatformSkillPinnedRef {
  checksum: string;
  skillKey: string;
  version: string;
}

export interface PlatformSkillOperationSnapshot {
  /** Agent identity bound into the server-signed operation proof. */
  agentId?: string;
  mandatorySkillIds?: string[];
  /** Operation identity bound into the server-signed operation proof. */
  operationId?: string;
  /** Short-lived server signature authorizing exact historical resolution. */
  proof?: string;
  refs: PlatformSkillPinnedRef[];
  revision: string;
  /** Client operations retain immutable public metadata for repeated context assembly. */
  skills?: PlatformPublishedSkill[];
}

export interface PlatformSkillSelection {
  /** Content is injected immediately for a pinned selection. */
  activated: boolean;
  /** Included in the operation candidate pool. */
  available: boolean;
  /** Whether a user may change this per-agent selection. */
  mutable: boolean;
}

/** Shared client/server interpretation of catalog distribution + agent tri-state. */
export const resolvePlatformSkillSelection = (
  distribution: PlatformSkillDistribution,
  mode: AgentPluginMode,
): PlatformSkillSelection => {
  if (distribution === 'mandatory') {
    return { activated: true, available: true, mutable: false };
  }
  if (distribution === 'optional') {
    const selected = mode === 'pinned';
    return { activated: selected, available: selected, mutable: true };
  }
  return {
    activated: mode === 'pinned',
    available: mode !== 'disabled',
    mutable: true,
  };
};

export const getPlatformSkillToggleMode = (
  distribution: PlatformSkillDistribution,
  enabled: boolean,
): AgentPluginMode | null => {
  if (distribution === 'mandatory') return null;
  if (!enabled) return 'disabled';
  return distribution === 'optional' ? 'pinned' : 'auto';
};
