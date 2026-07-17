import { z } from 'zod';

import {
  checksumPayload,
  PlatformSkillCatalogModel,
  platformSkillVersionChecksum,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type PlatformSkillPinnedRef,
  platformSkillPinnedRefSchema,
  type PublishedSkill,
  serverResolvedSkillSchema,
  type SkillManifest,
  type SkillResource,
} from '../../contracts/skillCatalog';
import { getPlatformConfigScopeVersion } from '../platformConfigInvalidation';

export interface BuiltinSkillDefinition extends PublishedSkill {
  content: string;
  contentRef?: string | null;
  manifest: SkillManifest;
  resources?: SkillResource[];
}

export interface SkillCatalogReadOptions {
  builtinSkills?: BuiltinSkillDefinition[];
  cacheTtlMs?: number;
  getCacheEpoch?: () => Promise<string>;
  model?: Pick<PlatformSkillCatalogModel, 'listPublished' | 'resolvePublishedVersion'>;
  now?: () => number;
}

export const builtinSkillDefinitionSchema = serverResolvedSkillSchema
  .omit({
    allowBuiltinOverride: true,
    skillId: true,
    versionId: true,
  })
  .extend({ source: z.literal('builtin') })
  .strict();
export const builtinSkillDefinitionsSchema = z.array(builtinSkillDefinitionSchema).max(100);
const MAX_PUBLISHED_SKILL_PAGES = 100;
const MAX_PUBLISHED_SKILLS = 10_000;
const MAX_READINESS_REVISIONS = 32;
const PUBLISHED_PROJECTION_CACHE_TTL_MS = 30_000;
const readinessByRevision = new Map<string, boolean>();
const activeProjectionRevisionBySource = new Map<
  string,
  { epoch: string; expiresAt: number; projectionKey: string }
>();

interface CachedPublishedProjection {
  catalog: { revision: string; skills: PublishedSkill[] };
  executionIndex: Map<string, ResolvedSkill>;
  executionReady: boolean;
}

const projectionByRevision = new Map<string, CachedPublishedProjection>();
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 1;

type ResolvedSkill = z.infer<typeof serverResolvedSkillSchema>;

const getSourceId = (source: object) => {
  const current = sourceIds.get(source);
  if (current) return current;
  const id = nextSourceId++;
  sourceIds.set(source, id);
  return id;
};

const cloneExecutionIndex = (index: Map<string, ResolvedSkill>) =>
  new Map([...index].map(([key, value]) => [key, structuredClone(value)]));

const cloneCatalog = (catalog: CachedPublishedProjection['catalog']) => structuredClone(catalog);

/**
 * Publication is the authority for moving the active projection. Cache entries are immutable and
 * revision-keyed; invalidation only drops the active source pointers so in-flight operations can
 * retain their already captured revision without observing a partially rebuilt projection.
 */
export const invalidatePublishedSkillCatalogReadCache = () => {
  activeProjectionRevisionBySource.clear();
};

export const resetPublishedSkillCatalogReadCacheForTest = () => {
  activeProjectionRevisionBySource.clear();
  projectionByRevision.clear();
  readinessByRevision.clear();
};

const exactRefKey = ({ checksum, skillKey, version }: PlatformSkillPinnedRef) =>
  `${skillKey}\0${version}\0${checksum}`;

const isCanonicalExactResolution = (ref: PlatformSkillPinnedRef, resolved: ResolvedSkill) =>
  resolved.skillKey === ref.skillKey &&
  resolved.version === ref.version &&
  resolved.checksum === ref.checksum &&
  platformSkillVersionChecksum({
    content: resolved.content,
    contentRef: resolved.contentRef,
    manifest: resolved.manifest,
    resources: resolved.resources,
  }) === ref.checksum;

const cacheReadiness = (revision: string, ready: boolean) => {
  readinessByRevision.delete(revision);
  readinessByRevision.set(revision, ready);
  if (readinessByRevision.size > MAX_READINESS_REVISIONS) {
    const oldest = readinessByRevision.keys().next().value;
    if (oldest) readinessByRevision.delete(oldest);
  }
};

export const getEmptyPublishedSkillCatalog = () => ({ revision: 'disabled', skills: [] });

const compareCodepoint = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export class SkillCatalogReadService {
  private readonly builtinSkills: BuiltinSkillDefinition[];
  private readonly cacheTtlMs: number;
  private readonly getCacheEpoch: () => Promise<string>;
  private readonly model: Pick<
    PlatformSkillCatalogModel,
    'listPublished' | 'resolvePublishedVersion'
  >;
  private publishedExecutionIndex = new Map<string, ResolvedSkill>();
  private publishedExecutionRevision: string | undefined;
  private readonly projectionSource: string;
  private readonly now: () => number;

  constructor(db: LobeChatDatabase | Transaction, options: SkillCatalogReadOptions = {}) {
    this.model = options.model ?? new PlatformSkillCatalogModel(db);
    this.cacheTtlMs = options.cacheTtlMs ?? PUBLISHED_PROJECTION_CACHE_TTL_MS;
    this.getCacheEpoch =
      options.getCacheEpoch ?? (() => getPlatformConfigScopeVersion('skill-catalog'));
    this.now = options.now ?? Date.now;
    const parsedBuiltins = builtinSkillDefinitionsSchema.parse(
      (options.builtinSkills ?? []).map((skill) => ({
        ...skill,
        contentRef: skill.contentRef ?? null,
        resources: skill.resources ?? [],
      })),
    );
    this.builtinSkills = parsedBuiltins as BuiltinSkillDefinition[];
    const source = options.model ?? db;
    const builtinRevision = checksumPayload({ builtinSkills: this.builtinSkills });
    this.projectionSource = `${getSourceId(source as object)}:${builtinRevision}`;
  }

  getPublishedCatalog = async () => {
    const epoch = await this.getCacheEpoch().catch(() => 'unavailable');
    const activeProjection = activeProjectionRevisionBySource.get(this.projectionSource);
    const cached =
      activeProjection &&
      activeProjection.epoch === epoch &&
      activeProjection.expiresAt > this.now()
        ? projectionByRevision.get(activeProjection.projectionKey)
        : undefined;
    if (cached) {
      this.publishedExecutionIndex = cloneExecutionIndex(cached.executionIndex);
      this.publishedExecutionRevision = cached.catalog.revision;
      cacheReadiness(cached.catalog.revision, cached.executionReady);
      return cloneCatalog(cached.catalog);
    }

    const platformItems: Awaited<ReturnType<PlatformSkillCatalogModel['listPublished']>>['items'] =
      [];
    const builtinOverrideTombstones = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      if (pageCount >= MAX_PUBLISHED_SKILL_PAGES) {
        throw new Error('Published Skill page limit was exceeded');
      }
      pageCount += 1;
      const page = await this.model.listPublished({ cursor, limit: 100 });
      for (const skillKey of page.builtinOverrideTombstones ?? []) {
        builtinOverrideTombstones.add(skillKey);
      }
      if (platformItems.length + page.items.length > MAX_PUBLISHED_SKILLS) {
        throw new Error('Published Skill item limit was exceeded');
      }
      platformItems.push(...page.items);
      if (!page.nextCursor) break;
      if (seenCursors.has(page.nextCursor))
        throw new Error('Published Skill cursor did not advance');
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    const builtins = new Map(this.builtinSkills.map((skill) => [skill.skillKey, skill] as const));
    for (const skillKey of builtinOverrideTombstones) builtins.delete(skillKey);
    const platformSkills: PublishedSkill[] = [];
    const platformResolvedByKey = new Map<string, ResolvedSkill>();
    for (const item of platformItems) {
      if (builtins.has(item.skillKey) && !item.allowBuiltinOverride) continue;
      platformSkills.push({
        checksum: item.version.checksum,
        description: item.description,
        displayName: item.displayName,
        distribution: item.distribution,
        skillKey: item.skillKey,
        source: item.source,
        version: item.version.version,
      });
      platformResolvedByKey.set(
        item.skillKey,
        serverResolvedSkillSchema.parse({
          allowBuiltinOverride: item.allowBuiltinOverride,
          checksum: item.version.checksum,
          content: item.version.content,
          contentRef: item.version.contentRef,
          description: item.description,
          displayName: item.displayName,
          distribution: item.distribution,
          manifest: item.version.manifest,
          resources: item.version.resources,
          skillId: item.skillId,
          skillKey: item.skillKey,
          source: item.source,
          version: item.version.version,
          versionId: item.version.id,
        }),
      );
    }

    const merged = new Map<string, PublishedSkill>(builtins);
    for (const skill of platformSkills) merged.set(skill.skillKey, skill);
    const skills = [...merged.values()]
      .map(({ checksum, description, displayName, distribution, skillKey, source, version }) => ({
        checksum,
        description,
        displayName,
        distribution,
        skillKey,
        source,
        version,
      }))
      .sort((left, right) => compareCodepoint(left.skillKey, right.skillKey));
    if (skills.length > MAX_PUBLISHED_SKILLS) {
      throw new Error('Published Skill item limit was exceeded after builtin merge');
    }
    const revision = checksumPayload({ skills });
    const executionIndex = new Map<string, ResolvedSkill>();
    let executionReady = true;
    for (const skill of skills) {
      const builtin = this.builtinSkills.find((item) => item.skillKey === skill.skillKey);
      const resolved =
        platformResolvedByKey.get(skill.skillKey) ??
        (builtin
          ? serverResolvedSkillSchema.parse({
              allowBuiltinOverride: false,
              checksum: builtin.checksum,
              content: builtin.content,
              contentRef: builtin.contentRef ?? null,
              description: builtin.description,
              displayName: builtin.displayName,
              distribution: builtin.distribution,
              manifest: builtin.manifest,
              resources: builtin.resources ?? [],
              skillId: `builtin:${builtin.skillKey}`,
              skillKey: builtin.skillKey,
              source: 'builtin',
              version: builtin.version,
              versionId: `builtin:${builtin.skillKey}@${builtin.version}`,
            })
          : undefined);
      const ref = { checksum: skill.checksum, skillKey: skill.skillKey, version: skill.version };
      if (
        !resolved ||
        !isCanonicalExactResolution(ref, resolved) ||
        resolved.contentRef !== null ||
        resolved.resources.some(
          (resource) => resource.content === undefined || resource.contentRef !== undefined,
        )
      ) {
        executionReady = false;
        continue;
      }
      executionIndex.set(exactRefKey(ref), structuredClone(resolved));
    }
    this.publishedExecutionIndex = cloneExecutionIndex(executionIndex);
    this.publishedExecutionRevision = revision;
    const ready = executionReady && executionIndex.size === skills.length;
    cacheReadiness(revision, ready);
    const catalog = {
      revision,
      skills,
    };
    const projectionKey = `${this.projectionSource}:${revision}`;
    projectionByRevision.delete(projectionKey);
    projectionByRevision.set(projectionKey, {
      catalog: cloneCatalog(catalog),
      executionIndex: cloneExecutionIndex(executionIndex),
      executionReady: ready,
    });
    activeProjectionRevisionBySource.set(this.projectionSource, {
      epoch,
      expiresAt: this.now() + this.cacheTtlMs,
      projectionKey,
    });
    while (projectionByRevision.size > MAX_READINESS_REVISIONS) {
      const oldest = projectionByRevision.keys().next().value;
      if (!oldest) break;
      projectionByRevision.delete(oldest);
    }
    return cloneCatalog(catalog);
  };

  isPublishedCatalogExecutionReady = (catalog: { revision: string; skills: PublishedSkill[] }) => {
    if (catalog.revision === this.publishedExecutionRevision) {
      return readinessByRevision.get(catalog.revision) ?? false;
    }
    return readinessByRevision.get(catalog.revision) ?? false;
  };

  resolveForExecution = async (skillKey: string, version?: string) => {
    const builtin = this.builtinSkills.find((item) => item.skillKey === skillKey);
    if (!version) {
      const catalog = await this.getPublishedCatalog();
      const current = catalog.skills.find((skill) => skill.skillKey === skillKey);
      if (!current) return undefined;
      const indexed = this.publishedExecutionIndex.get(
        exactRefKey({
          checksum: current.checksum,
          skillKey: current.skillKey,
          version: current.version,
        }),
      );
      if (indexed) return structuredClone(indexed);
      if (current.source === 'builtin') {
        if (
          !builtin ||
          builtin.version !== current.version ||
          builtin.checksum !== current.checksum
        ) {
          return undefined;
        }
        return serverResolvedSkillSchema.parse({
          allowBuiltinOverride: false,
          checksum: builtin.checksum,
          content: builtin.content,
          contentRef: builtin.contentRef ?? null,
          description: builtin.description,
          displayName: builtin.displayName,
          distribution: builtin.distribution,
          manifest: builtin.manifest,
          resources: builtin.resources ?? [],
          skillId: `builtin:${builtin.skillKey}`,
          skillKey: builtin.skillKey,
          source: 'builtin',
          version: builtin.version,
          versionId: `builtin:${builtin.skillKey}@${builtin.version}`,
        });
      }
      const platform = await this.model.resolvePublishedVersion(skillKey);
      if (
        !platform ||
        platform.version.version !== current.version ||
        platform.version.checksum !== current.checksum
      ) {
        return undefined;
      }
      return serverResolvedSkillSchema.parse({
        allowBuiltinOverride: platform.allowBuiltinOverride,
        checksum: platform.version.checksum,
        content: platform.version.content,
        contentRef: platform.version.contentRef,
        description: platform.description,
        displayName: platform.displayName,
        distribution: platform.distribution,
        manifest: platform.version.manifest,
        resources: platform.version.resources,
        skillId: platform.skillId,
        skillKey: platform.skillKey,
        source: platform.source,
        version: platform.version.version,
        versionId: platform.version.id,
      });
    }
    const platform = await this.model.resolvePublishedVersion(skillKey, version);
    if (platform && (!builtin || platform.allowBuiltinOverride)) {
      return serverResolvedSkillSchema.parse({
        allowBuiltinOverride: platform.allowBuiltinOverride,
        checksum: platform.version.checksum,
        content: platform.version.content,
        contentRef: platform.version.contentRef,
        description: platform.description,
        displayName: platform.displayName,
        distribution: platform.distribution,
        manifest: platform.version.manifest,
        resources: platform.version.resources,
        skillId: platform.skillId,
        skillKey: platform.skillKey,
        source: platform.source,
        version: platform.version.version,
        versionId: platform.version.id,
      });
    }
    if (builtin?.version === version) {
      return serverResolvedSkillSchema.parse({
        allowBuiltinOverride: false,
        checksum: builtin.checksum,
        content: builtin.content,
        contentRef: builtin.contentRef ?? null,
        description: builtin.description,
        displayName: builtin.displayName,
        distribution: builtin.distribution,
        manifest: builtin.manifest,
        resources: builtin.resources ?? [],
        skillId: `builtin:${builtin.skillKey}`,
        skillKey: builtin.skillKey,
        source: 'builtin',
        version: builtin.version,
        versionId: `builtin:${builtin.skillKey}@${builtin.version}`,
      });
    }
    return undefined;
  };

  /**
   * Resolve the immutable operation reference and verify both coordinates.
   * A version-only lookup is insufficient: a corrupted or replaced immutable
   * row must never execute under a checksum captured by an older operation.
   */
  resolvePinnedForExecution = async (input: PlatformSkillPinnedRef) => {
    const ref = platformSkillPinnedRefSchema.parse(input);
    const indexed = this.publishedExecutionIndex.get(exactRefKey(ref));
    const resolved = indexed ?? (await this.resolveForExecution(ref.skillKey, ref.version));
    if (!resolved || !isCanonicalExactResolution(ref, resolved)) return undefined;
    return structuredClone(resolved);
  };
}
