import { and, eq, sql } from 'drizzle-orm';

import { PlatformSkillCatalogRepository } from '../../repositories/platformSkillCatalog';
import type {
  PlatformDistribution,
  PlatformSkillManifest,
  PlatformSkillResource,
  PlatformSkillValidationResult,
} from '../../schemas/platform';
import { platformSkillVersions } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';
import {
  canonicalizePlatformSkillContent,
  canonicalizePlatformSkillManifest,
  canonicalizePlatformSkillResources,
  draftView,
  parsePlatformPublishedSkillSnapshot,
  type PlatformPublishedSkillPageView,
  type PlatformPublishedSkillView,
  PlatformSkillBuiltinOverrideError,
  PlatformSkillChecksumMismatchError,
  type PlatformSkillDetailView,
  platformSkillDraftToken,
  platformSkillVersionChecksum,
  type PlatformSkillVersionView,
  publishedView,
  versionView,
} from './skillCanonicalize';

interface PlatformSkillCatalogModelOptions {
  allowBuiltinOverride?: boolean;
  builtinSkillKeys?: ReadonlySet<string>;
}

/** Aggregate model. Version content is append-only; identity edits never update a version row. */
export class PlatformSkillCatalogModel {
  constructor(
    private readonly db: LobeChatDatabase | Transaction,
    private readonly options: PlatformSkillCatalogModelOptions = {},
  ) {}

  private transaction = async <T>(callback: (tx: Transaction) => Promise<T>): Promise<T> => {
    if ('transaction' in this.db) return this.db.transaction(callback);
    return callback(this.db);
  };

  private assertDraft = async (
    repository: PlatformSkillCatalogRepository,
    id: string,
    expectedDraftToken: string,
    expectedRevision: number,
  ) => {
    const row = await repository.lockSkill(id);
    const draft = draftView(row);
    if (!draft) return undefined;
    // Archived is terminal for draft mutations (identity / versions / validate).
    // Recovery for previously published skills goes through rollback, not draft edits.
    if (draft.status === 'archived') return undefined;
    if (
      draft.revision !== expectedRevision ||
      platformSkillDraftToken(draft) !== expectedDraftToken
    ) {
      throw new PlatformRevisionConflictError('Skill draft changed', {
        currentRevision: draft.revision,
        expectedRevision,
        resourceId: id,
        resourceType: 'skill',
      });
    }
    return draft;
  };

  createSkill = async (params: {
    actorUserId?: string;
    allowBuiltinOverride?: boolean;
    description?: string | null;
    displayName: string;
    distribution?: PlatformDistribution;
    enabled?: boolean;
    skillKey: string;
  }): Promise<PlatformSkillDetailView> => {
    if (
      this.options.builtinSkillKeys?.has(params.skillKey) &&
      !(params.allowBuiltinOverride && this.options.allowBuiltinOverride)
    ) {
      throw new PlatformSkillBuiltinOverrideError();
    }
    const row = await new PlatformSkillCatalogRepository(this.db).createSkill({
      allowBuiltinOverride: params.allowBuiltinOverride ?? false,
      createdBy: params.actorUserId,
      description: params.description,
      distribution: params.distribution,
      enabled: params.enabled,
      name: params.displayName,
      skillKey: params.skillKey,
      source: 'uploaded',
      updatedBy: params.actorUserId,
    });
    const detail = await this.getDetail(row.id);
    if (!detail) throw new Error('Failed to read created Skill');
    return detail;
  };

  createVersion = async (params: {
    actorUserId?: string;
    checksum: string;
    content: string;
    contentRef?: string | null;
    expectedDraftToken: string;
    expectedRevision: number;
    manifest: PlatformSkillManifest;
    resources?: PlatformSkillResource[];
    skillId: string;
    validation?: PlatformSkillValidationResult | null;
    version: string;
  }): Promise<PlatformSkillVersionView | undefined> => {
    if (platformSkillVersionChecksum(params) !== params.checksum) {
      throw new PlatformSkillChecksumMismatchError();
    }
    return this.transaction(async (tx) => {
      const repository = new PlatformSkillCatalogRepository(tx);
      const current = await this.assertDraft(
        repository,
        params.skillId,
        params.expectedDraftToken,
        params.expectedRevision,
      );
      if (!current) return undefined;
      const canonicalManifest = canonicalizePlatformSkillManifest(params.manifest);
      const canonicalResources = canonicalizePlatformSkillResources(params.resources ?? []);
      const row = await repository.createVersion({
        checksum: params.checksum,
        content: canonicalizePlatformSkillContent(params.content),
        contentRef: params.contentRef ? canonicalizePlatformSkillContent(params.contentRef) : null,
        createdBy: params.actorUserId,
        manifest: canonicalManifest,
        resources: canonicalResources,
        skillId: params.skillId,
        validationResult: params.validation,
        version: params.version,
      });
      await repository.bumpDraftSequence(params.skillId);
      return versionView(row);
    });
  };

  getDetail = async (id: string): Promise<PlatformSkillDetailView | undefined> => {
    const repository = new PlatformSkillCatalogRepository(this.db);
    const draft = draftView(await repository.getSkill(id));
    if (!draft) return undefined;
    const latest = await repository.getLatestVersion(id);
    const published = draft.currentVersionId
      ? await repository.getVersion(id, draft.currentVersionId)
      : undefined;
    return {
      baseRevision: draft.revision,
      draft,
      draftToken: platformSkillDraftToken(draft),
      latestVersion: latest ? versionView(latest) : null,
      publishedVersion: published ? versionView(published) : null,
    };
  };

  listSkills = async (params: Parameters<PlatformSkillCatalogRepository['listSkills']>[0]) => {
    const page = await new PlatformSkillCatalogRepository(this.db).listSkills(params);
    return {
      items: page.items.map((item) => draftView(item)!),
      nextCursor: page.nextCursor,
    };
  };

  listPublished = async (
    params: Parameters<PlatformSkillCatalogRepository['listPublished']>[0] = {},
  ): Promise<PlatformPublishedSkillPageView> => {
    const page = await new PlatformSkillCatalogRepository(this.db).listPublished(params);
    // Parse each published snapshot exactly once, then derive tombstones, catalog tokens and
    // views from that single pass (previously each row was JSON-validated up to three times).
    const parsedItems = page.items.map((row) => ({
      row,
      snapshot: parsePlatformPublishedSkillSnapshot(row.payload),
    }));
    const builtinOverrideTombstones = parsedItems.flatMap(({ row, snapshot }) =>
      row.status === 'archived' &&
      snapshot?.builtinOverrideTombstone === true &&
      snapshot.skill.allowBuiltinOverride
        ? [snapshot.skill.skillKey]
        : [],
    );
    const catalogTokenEntries = parsedItems.flatMap(({ row, snapshot }) => {
      const tombstone =
        row.status === 'archived' &&
        snapshot?.builtinOverrideTombstone === true &&
        snapshot.skill.allowBuiltinOverride;
      if (!snapshot || (row.status !== 'published' && !tombstone)) return [];
      return [
        {
          checksum: row.version.checksum,
          currentVersionId: row.version.id,
          revision: row.revision,
          skillId: row.skillId,
          skillKey: snapshot.skill.skillKey,
          tombstone,
        },
      ];
    });
    return {
      builtinOverrideTombstones,
      catalogTokenEntries,
      items: parsedItems.flatMap(({ row, snapshot }) => {
        const view = publishedView(row, snapshot);
        return view ? [view] : [];
      }),
      nextCursor: page.nextCursor,
    };
  };

  resolvePublishedVersion = async (
    skillKey: string,
    version?: string,
  ): Promise<PlatformPublishedSkillView | undefined> => {
    const row = await new PlatformSkillCatalogRepository(this.db).resolveVersion(skillKey, version);
    return row ? publishedView(row) : undefined;
  };

  /** Batch exact-version resolution for dependency-graph frontiers. */
  resolvePublishedVersionsExact = async (
    references: readonly { skillKey: string; version: string }[],
  ): Promise<Map<string, PlatformPublishedSkillView>> => {
    const rows = await new PlatformSkillCatalogRepository(this.db).resolveVersionsExact(references);
    const out = new Map<string, PlatformPublishedSkillView>();
    for (const [key, row] of rows) {
      const view = publishedView(row);
      if (view) out.set(key, view);
    }
    return out;
  };

  updateDraft = async (params: {
    actorUserId?: string;
    description?: string | null;
    displayName?: string;
    distribution?: PlatformDistribution;
    enabled?: boolean;
    expectedDraftToken: string;
    expectedRevision: number;
    id: string;
  }): Promise<PlatformSkillDetailView | undefined> => {
    return this.transaction(async (tx) => {
      const repository = new PlatformSkillCatalogRepository(tx);
      const current = await this.assertDraft(
        repository,
        params.id,
        params.expectedDraftToken,
        params.expectedRevision,
      );
      if (!current) return undefined;
      await repository.updateSkillDraft(params.id, {
        description: params.description,
        distribution: params.distribution,
        enabled: params.enabled,
        name: params.displayName,
        updatedBy: params.actorUserId,
      });
      return new PlatformSkillCatalogModel(tx, this.options).getDetail(params.id);
    });
  };

  /**
   * Persist a re-validated result onto an immutable version row (metadata only).
   * Content fields are never rewritten.
   *
   * Escape hatch: transaction-local GUC `lobe.allow_platform_skill_version_validation_update=on`
   * is the intended contract for `prevent_platform_skill_version_mutation` (same pattern as
   * agent version delete / audit retention). Callers MUST run this inside an open transaction
   * so the GUC stays local and rolls back atomically with the validation write + required
   * success audit. Does **not** disable triggers (no `session_replication_role`).
   *
   * Requires the migration-owned trigger to honor the GUC for validation_result-only UPDATEs.
   */
  updateVersionValidation = async (params: {
    skillId: string;
    validation: PlatformSkillValidationResult;
    versionId: string;
  }): Promise<boolean> => {
    await this.db.execute(
      sql`SELECT set_config('lobe.allow_platform_skill_version_validation_update', 'on', true)`,
    );
    const [row] = await this.db
      .update(platformSkillVersions)
      .set({ validationResult: params.validation })
      .where(
        and(
          eq(platformSkillVersions.skillId, params.skillId),
          eq(platformSkillVersions.id, params.versionId),
        ),
      )
      .returning({ id: platformSkillVersions.id });
    return Boolean(row);
  };
}
