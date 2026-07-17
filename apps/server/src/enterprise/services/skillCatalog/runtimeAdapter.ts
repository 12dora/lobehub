import type { PlatformSkillOperationSnapshot } from '@lobechat/context-engine';
import type { SkillItem, SkillListItem, SkillResourceContent } from '@lobechat/types';

import type { LobeChatDatabase } from '@/database/type';

import type { PlatformSkillPinnedRef } from '../../contracts/skillCatalog';
import { getBuiltinSkillDefinitions } from './builtinAdapter';
import { SkillCatalogReadService } from './readService';

const PLATFORM_SKILL_ID_PREFIX = 'platform-skill:';
const MAX_RESOLUTION_CACHE_ENTRIES = 128;

type ResolvedPlatformSkill = NonNullable<
  Awaited<ReturnType<SkillCatalogReadService['resolvePinnedForExecution']>>
>;

const runtimeId = (ref: PlatformSkillPinnedRef) =>
  `${PLATFORM_SKILL_ID_PREFIX}${ref.skillKey}@${ref.version}#${ref.checksum}`;

const toSkillItem = (resolved: ResolvedPlatformSkill): SkillItem => ({
  content: resolved.content,
  createdAt: new Date(0),
  description: resolved.description,
  id: runtimeId(resolved),
  identifier: resolved.skillKey,
  manifest: {
    description: resolved.manifest.description,
    name: resolved.skillKey,
    version: resolved.version,
  },
  name: resolved.skillKey,
  resources: Object.fromEntries(
    resolved.resources.map((resource) => [
      resource.path,
      {
        content: resource.content,
        fileHash: resource.checksum,
        size: resource.sizeBytes,
      },
    ]),
  ),
  source: 'user',
  updatedAt: new Date(0),
});

const toSkillListItem = (
  ref: PlatformSkillPinnedRef,
  metadata?: { description?: string | null; displayName?: string },
): SkillListItem => ({
  createdAt: new Date(0),
  description: metadata?.description ?? '',
  id: runtimeId(ref),
  identifier: ref.skillKey,
  manifest: { description: metadata?.description ?? '', name: ref.skillKey, version: ref.version },
  name: metadata?.displayName ?? ref.skillKey,
  source: 'user',
  updatedAt: new Date(0),
});

/**
 * Operation-scoped resolver. Its bounded cache is keyed by catalog revision
 * and exact immutable reference; failed lookups are cached as fail-closed
 * misses for the remainder of the operation/tool runtime instance.
 */
export class PlatformSkillOperationResolver {
  private readonly cache = new Map<string, ResolvedPlatformSkill | undefined>();
  private readonly refsById: Map<string, PlatformSkillPinnedRef>;
  private readonly refsByKey: Map<string, PlatformSkillPinnedRef>;
  private readonly metadataByKey: Map<
    string,
    { description?: string | null; displayName?: string }
  >;

  private readonly snapshot: PlatformSkillOperationSnapshot;

  constructor(
    snapshot: PlatformSkillOperationSnapshot,
    private readonly service: Pick<SkillCatalogReadService, 'resolvePinnedForExecution'>,
  ) {
    const clone = structuredClone(snapshot);
    for (const ref of clone.refs) Object.freeze(ref);
    for (const skill of clone.skills ?? []) Object.freeze(skill);
    Object.freeze(clone.refs);
    if (clone.skills) Object.freeze(clone.skills);
    if (clone.mandatorySkillIds) Object.freeze(clone.mandatorySkillIds);
    this.snapshot = Object.freeze(clone) as PlatformSkillOperationSnapshot;
    this.refsByKey = new Map(this.snapshot.refs.map((ref) => [ref.skillKey, ref]));
    this.refsById = new Map(this.snapshot.refs.map((ref) => [runtimeId(ref), ref]));
    this.metadataByKey = new Map(
      this.snapshot.skills?.map((skill) => [skill.skillKey, skill] as const),
    );
  }

  findAll = async (): Promise<{ data: SkillListItem[]; total: number }> => {
    const data = [...this.refsByKey.values()].map((ref) =>
      toSkillListItem(ref, this.metadataByKey.get(ref.skillKey)),
    );
    return { data, total: data.length };
  };

  findById = async (id: string): Promise<SkillItem | undefined> => {
    if (!id.startsWith(PLATFORM_SKILL_ID_PREFIX)) return undefined;
    const ref = this.refsById.get(id);
    return ref ? this.resolve(ref) : undefined;
  };

  findByName = async (name: string): Promise<SkillItem | undefined> => {
    const ref = this.refsByKey.get(name);
    return ref ? this.resolve(ref) : undefined;
  };

  readResource = async (id: string, path: string): Promise<SkillResourceContent> => {
    const skill = await this.findById(id);
    const resource = skill?.resources?.[path];
    if (resource?.content === undefined) {
      throw new Error(`Platform Skill resource is unavailable: ${path}`);
    }
    return {
      content: resource.content,
      encoding: 'utf8',
      fileHash: resource.fileHash,
      fileType: 'text/plain',
      path,
      size: resource.size,
    };
  };

  private resolve = async (ref: PlatformSkillPinnedRef): Promise<SkillItem | undefined> => {
    const cacheKey = `${this.snapshot.revision}:${runtimeId(ref)}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      return cached ? toSkillItem(cached) : undefined;
    }
    const resolved = await this.service.resolvePinnedForExecution(ref);
    const executionReady =
      resolved?.contentRef === null &&
      resolved.resources.every(
        (resource) => resource.content !== undefined && resource.contentRef === undefined,
      );
    if (this.cache.size >= MAX_RESOLUTION_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, executionReady ? resolved : undefined);
    return executionReady && resolved ? toSkillItem(resolved) : undefined;
  };
}

export const createPlatformSkillOperationResolver = (
  db: LobeChatDatabase,
  snapshot: PlatformSkillOperationSnapshot,
) =>
  new PlatformSkillOperationResolver(
    snapshot,
    new SkillCatalogReadService(db, { builtinSkills: getBuiltinSkillDefinitions() }),
  );
