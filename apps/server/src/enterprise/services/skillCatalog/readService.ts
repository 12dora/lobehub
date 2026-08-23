import { z } from 'zod';

import { checksumPayload, PlatformSkillCatalogModel } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type PlatformSkillPinnedRef,
  platformSkillPinnedRefSchema,
  type PublishedSkill,
  serverResolvedSkillSchema,
} from '../../contracts/skillCatalog';
import { DomainConfigCache } from '../../runtimeConfig';
import { getPlatformConfigScopeVersion } from '../platformConfigInvalidation';
import type { CurrentSkillCatalogSnapshot } from '../platformInstance/catalogAuthority';
import { loadCurrentSkillCatalogSnapshot } from '../platformInstance/catalogAuthority';
import type { PlatformRuntimeMaterializationReporter } from '../platformInstance/runtimeReporter';
import {
  classifyRuntimeMaterializationError,
  reportPlatformRuntimeMaterialization,
  reportPlatformRuntimeMaterializationSafely,
} from '../platformInstance/runtimeReporter';
import { loadPublishedSkillProjection } from './publishedSkillProjection';
import {
  cacheReadiness,
  cloneCatalog,
  getSourceId,
  invalidatePublishedSkillCatalogReadCache,
  projectionByRevision,
  readinessByRevision,
  resetPublishedSkillCatalogReadCacheForTest,
  SKILL_ACTIVE_PROJECTION_CACHE_NAMESPACE,
} from './readServiceCache';
import type { BuiltinSkillDefinition, ResolvedSkill } from './resolvedSkill';
import {
  exactRefKey,
  isCanonicalExactResolution,
  parseResolvedBuiltinSkill,
  parseResolvedPlatformSkill,
} from './resolvedSkill';

export type { BuiltinSkillDefinition } from './resolvedSkill';
export { invalidatePublishedSkillCatalogReadCache, resetPublishedSkillCatalogReadCacheForTest };

export interface SkillCatalogReadOptions {
  builtinSkills?: BuiltinSkillDefinition[];
  cacheTtlMs?: number;
  getCacheEpoch?: () => Promise<string>;
  loadCurrentSnapshot?: () => Promise<CurrentSkillCatalogSnapshot>;
  model?: Pick<
    PlatformSkillCatalogModel,
    'resolvePublishedVersion' | 'resolvePublishedVersionsExact'
  >;
  now?: () => number;
  runtimeReporting?: {
    database: LobeChatDatabase;
    reporter?: PlatformRuntimeMaterializationReporter;
  };
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

export const getEmptyPublishedSkillCatalog = () => ({ revision: 'disabled', skills: [] });

const reportProjectionStored = (
  reportRuntimeState: typeof reportPlatformRuntimeMaterialization,
  database: LobeChatDatabase,
) => {
  return (projectionKey: string | null) => {
    const projection = projectionKey ? projectionByRevision.get(projectionKey) : undefined;
    if (!projection?.executionReady) {
      reportPlatformRuntimeMaterializationSafely(reportRuntimeState, database, {
        domain: 'skill_catalog',
        errorCategory: 'configuration_invalid',
        health: 'unavailable',
        source: 'unavailable',
      });
      return;
    }
    reportPlatformRuntimeMaterializationSafely(reportRuntimeState, database, {
      domain: 'skill_catalog',
      health: 'healthy',
      revisionId: projection.targetRevisionId,
      source: 'database',
    });
  };
};

const reportProjectionLoadFailure = (
  reportRuntimeState: typeof reportPlatformRuntimeMaterialization,
  database: LobeChatDatabase,
) => {
  return (error: unknown) => {
    reportPlatformRuntimeMaterializationSafely(reportRuntimeState, database, {
      domain: 'skill_catalog',
      errorCategory: classifyRuntimeMaterializationError(error),
      health: 'unavailable',
      source: 'unavailable',
    });
  };
};

export class SkillCatalogReadService {
  private readonly activeProjectionCache: DomainConfigCache<string>;
  private readonly builtinSkills: BuiltinSkillDefinition[];
  private readonly loadCurrentSnapshot: () => Promise<CurrentSkillCatalogSnapshot>;
  private readonly model: Pick<
    PlatformSkillCatalogModel,
    'resolvePublishedVersion' | 'resolvePublishedVersionsExact'
  >;
  private publishedExecutionIndex: ReadonlyMap<string, ResolvedSkill> = new Map();
  private readonly projectionSource: string;

  constructor(db: LobeChatDatabase | Transaction, options: SkillCatalogReadOptions = {}) {
    this.model = options.model ?? new PlatformSkillCatalogModel(db);
    this.loadCurrentSnapshot =
      options.loadCurrentSnapshot ?? (() => loadCurrentSkillCatalogSnapshot(db));
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
    const runtimeReporting = options.runtimeReporting;
    const reportRuntimeState = runtimeReporting?.reporter ?? reportPlatformRuntimeMaterialization;
    this.activeProjectionCache = new DomainConfigCache({
      cacheId: `${builtinRevision}:${runtimeReporting ? 'runtime' : 'read'}`,
      cacheKey: source as object,
      cacheTtlMs: options.cacheTtlMs,
      cloneValue: (value) => value,
      getScopeEpoch:
        options.getCacheEpoch ?? (() => getPlatformConfigScopeVersion('skill-catalog')),
      load: this.loadPublishedProjection,
      namespace: SKILL_ACTIVE_PROJECTION_CACHE_NAMESPACE,
      now: options.now,
      observabilityDomain: 'skill_catalog',
      onEntryStored: runtimeReporting
        ? reportProjectionStored(reportRuntimeState, runtimeReporting.database)
        : undefined,
      onLoadFailure: runtimeReporting
        ? reportProjectionLoadFailure(reportRuntimeState, runtimeReporting.database)
        : undefined,
    });
  }

  private loadPublishedProjection = async (): Promise<string> =>
    loadPublishedSkillProjection({
      builtinSkills: this.builtinSkills,
      loadCurrentSnapshot: this.loadCurrentSnapshot,
      projectionSource: this.projectionSource,
    });

  getPublishedCatalog = async () => {
    let projectionKey = await this.activeProjectionCache.get();
    let cached = projectionKey ? projectionByRevision.get(projectionKey) : undefined;

    // Immutable projections are independently bounded. If its active pointer outlives the
    // projection, rebuild from the database instead of returning an incomplete catalog.
    if (!cached) {
      this.activeProjectionCache.invalidate();
      projectionKey = await this.activeProjectionCache.get();
      cached = projectionKey ? projectionByRevision.get(projectionKey) : undefined;
    }
    if (!cached) throw new Error('Published Skill projection could not be rebuilt');

    this.publishedExecutionIndex = cached.executionIndex;
    cacheReadiness(cached.catalog.revision, cached.executionReady);
    return cloneCatalog(cached.catalog);
  };

  isPublishedCatalogExecutionReady = (catalog: { revision: string; skills: PublishedSkill[] }) =>
    readinessByRevision.get(catalog.revision) ?? false;

  resolveForExecution = async (skillKey: string, version?: string) => {
    const builtin = this.builtinSkills.find((item) => item.skillKey === skillKey);
    if (!version) {
      return this.resolveCurrentForExecution(skillKey, builtin);
    }
    const platform = await this.model.resolvePublishedVersion(skillKey, version);
    if (platform && (!builtin || platform.allowBuiltinOverride)) {
      return parseResolvedPlatformSkill(platform);
    }
    if (builtin?.version === version) {
      return parseResolvedBuiltinSkill(builtin);
    }
    return undefined;
  };

  private resolveCurrentForExecution = async (
    skillKey: string,
    builtin: BuiltinSkillDefinition | undefined,
  ) => {
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
      return parseResolvedBuiltinSkill(builtin);
    }
    const platform = await this.model.resolvePublishedVersion(skillKey);
    if (
      !platform ||
      platform.version.version !== current.version ||
      platform.version.checksum !== current.checksum
    ) {
      return undefined;
    }
    return parseResolvedPlatformSkill(platform);
  };

  /**
   * Batch exact-version resolution for one dependency-graph frontier.
   * Returns a map keyed by `skillKey\0version`. Missing refs map to undefined.
   */
  resolveForExecutionBatch = async (
    refs: readonly { skillKey: string; version: string }[],
  ): Promise<Map<string, ResolvedSkill | undefined>> => {
    const out = new Map<string, ResolvedSkill | undefined>();
    if (refs.length === 0) return out;

    const unique = new Map<string, { skillKey: string; version: string }>();
    for (const ref of refs) {
      unique.set(`${ref.skillKey}\0${ref.version}`, ref);
    }
    const platformBatch = await this.loadExactPlatformBatch([...unique.values()]);

    for (const [key, ref] of unique) {
      const builtin = this.builtinSkills.find((item) => item.skillKey === ref.skillKey);
      const platform = platformBatch.get(key);
      if (platform && (!builtin || platform.allowBuiltinOverride)) {
        out.set(key, parseResolvedPlatformSkill(platform));
        continue;
      }
      if (builtin?.version === ref.version) {
        out.set(key, parseResolvedBuiltinSkill(builtin));
        continue;
      }
      out.set(key, undefined);
    }
    return out;
  };

  private loadExactPlatformBatch = async (refs: Array<{ skillKey: string; version: string }>) => {
    if (typeof this.model.resolvePublishedVersionsExact === 'function') {
      return this.model.resolvePublishedVersionsExact(refs);
    }
    return new Map(
      await Promise.all(
        refs.map(async (ref) => {
          const platform = await this.model.resolvePublishedVersion(ref.skillKey, ref.version);
          // Key as plain string so the Map union with resolvePublishedVersionsExact
          // does not force callers to pass a template-literal branded key.
          return [`${ref.skillKey}\0${ref.version}`, platform] as [string, typeof platform];
        }),
      ),
    );
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
