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

export interface BuiltinSkillDefinition extends PublishedSkill {
  content: string;
  contentRef?: string | null;
  manifest: SkillManifest;
  resources?: SkillResource[];
}

export interface SkillCatalogReadOptions {
  builtinSkills?: BuiltinSkillDefinition[];
  model?: Pick<PlatformSkillCatalogModel, 'listPublished' | 'resolvePublishedVersion'>;
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
const readinessByRevision = new Map<string, boolean>();

type ResolvedSkill = z.infer<typeof serverResolvedSkillSchema>;

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
  private readonly model: Pick<
    PlatformSkillCatalogModel,
    'listPublished' | 'resolvePublishedVersion'
  >;
  private publishedExecutionIndex = new Map<string, ResolvedSkill>();
  private publishedExecutionRevision: string | undefined;

  constructor(db: LobeChatDatabase | Transaction, options: SkillCatalogReadOptions = {}) {
    this.model = options.model ?? new PlatformSkillCatalogModel(db);
    const parsedBuiltins = builtinSkillDefinitionsSchema.parse(
      (options.builtinSkills ?? []).map((skill) => ({
        ...skill,
        contentRef: skill.contentRef ?? null,
        resources: skill.resources ?? [],
      })),
    );
    this.builtinSkills = parsedBuiltins as BuiltinSkillDefinition[];
  }

  getPublishedCatalog = async () => {
    const platformItems: Awaited<ReturnType<PlatformSkillCatalogModel['listPublished']>>['items'] =
      [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      if (pageCount >= MAX_PUBLISHED_SKILL_PAGES) {
        throw new Error('Published Skill page limit was exceeded');
      }
      pageCount += 1;
      const page = await this.model.listPublished({ cursor, limit: 100 });
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
    const revision = checksumPayload({ skills });
    const executionIndex = new Map<string, ResolvedSkill>();
    let executionReady = skills.length > 0;
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
    this.publishedExecutionIndex = executionIndex;
    this.publishedExecutionRevision = revision;
    cacheReadiness(revision, executionReady && executionIndex.size === skills.length);
    return {
      revision,
      skills,
    };
  };

  isPublishedCatalogExecutionReady = (catalog: { revision: string; skills: PublishedSkill[] }) => {
    if (catalog.revision === this.publishedExecutionRevision) {
      return readinessByRevision.get(catalog.revision) ?? false;
    }
    return readinessByRevision.get(catalog.revision) ?? false;
  };

  resolveForExecution = async (skillKey: string, version?: string) => {
    const builtin = this.builtinSkills.find((item) => item.skillKey === skillKey);
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
    if (version) {
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
    }

    if (!builtin) return undefined;
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
