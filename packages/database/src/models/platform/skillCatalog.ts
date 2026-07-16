import { PlatformSkillCatalogRepository } from '../../repositories/platformSkillCatalog';
import type {
  PlatformDistribution,
  PlatformResourceStatus,
  PlatformSkillManifest,
  PlatformSkillSource,
  PlatformSkillValidationResult,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { checksumPayload } from './checksum';
import { PlatformRevisionConflictError } from './errors';

export interface PlatformSkillDraftView {
  allowBuiltinOverride: boolean;
  currentVersionId: string | null;
  description: string | null;
  displayName: string;
  distribution: PlatformDistribution;
  enabled: boolean;
  id: string;
  revision: number;
  skillKey: string;
  source: PlatformSkillSource;
  status: PlatformResourceStatus;
}

export interface PlatformSkillVersionView {
  checksum: string;
  content: string;
  contentRef: string | null;
  createdAt: Date;
  createdBy: string | null;
  id: string;
  manifest: PlatformSkillManifest;
  skillId: string;
  validation: PlatformSkillValidationResult | null;
  version: string;
}

export interface PlatformSkillDetailView {
  baseRevision: number;
  draft: PlatformSkillDraftView;
  draftToken: string;
  publishedVersion: PlatformSkillVersionView | null;
  versions: PlatformSkillVersionView[];
}

export class PlatformSkillBuiltinOverrideError extends Error {
  readonly code = 'PLATFORM_SKILL_BUILTIN_OVERRIDE_FORBIDDEN' as const;

  constructor() {
    super('Builtin Skill keys cannot be overridden unless allowOverride is explicitly enabled');
    this.name = 'PlatformSkillBuiltinOverrideError';
  }
}

export class PlatformSkillChecksumMismatchError extends Error {
  readonly code = 'PLATFORM_SKILL_CHECKSUM_MISMATCH' as const;

  constructor() {
    super('Skill version checksum does not match its canonical manifest and content');
    this.name = 'PlatformSkillChecksumMismatchError';
  }
}

const draftView = (row: Awaited<ReturnType<PlatformSkillCatalogRepository['getSkill']>>) => {
  if (!row) return undefined;
  return {
    allowBuiltinOverride: row.allowBuiltinOverride,
    currentVersionId: row.currentVersionId ?? null,
    description: row.description ?? null,
    displayName: row.name,
    distribution: row.distribution,
    enabled: row.enabled,
    id: row.id,
    revision: row.revision,
    skillKey: row.skillKey,
    source: row.source,
    status: row.status,
  } satisfies PlatformSkillDraftView;
};

const versionView = (
  row: Awaited<ReturnType<PlatformSkillCatalogRepository['listVersions']>>[number],
): PlatformSkillVersionView => ({
  checksum: row.checksum,
  content: row.content,
  contentRef: row.contentRef ?? null,
  createdAt: row.createdAt,
  createdBy: row.createdBy ?? null,
  id: row.id,
  manifest: row.manifest,
  skillId: row.skillId,
  validation: row.validationResult ?? null,
  version: row.version,
});

export const platformSkillVersionChecksum = (params: {
  content: string;
  manifest: PlatformSkillManifest;
}) => checksumPayload({ content: params.content, manifest: params.manifest });

export const platformSkillDraftToken = (
  draft: PlatformSkillDraftView,
  versions: PlatformSkillVersionView[],
) =>
  checksumPayload({
    draft,
    versions: versions.map(({ checksum, id, version }) => ({ checksum, id, version })),
  });

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
    const versions = (await repository.listVersions(id)).map(versionView);
    if (
      draft.revision !== expectedRevision ||
      platformSkillDraftToken(draft, versions) !== expectedDraftToken
    ) {
      throw new PlatformRevisionConflictError('Skill draft changed', {
        currentRevision: draft.revision,
        expectedRevision,
        resourceId: id,
        resourceType: 'skill',
      });
    }
    return { draft, versions };
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
      const row = await repository.createVersion({
        checksum: params.checksum,
        content: params.content,
        contentRef: params.contentRef,
        createdBy: params.actorUserId,
        manifest: params.manifest,
        skillId: params.skillId,
        validationResult: params.validation,
        version: params.version,
      });
      return versionView(row);
    });
  };

  getDetail = async (id: string): Promise<PlatformSkillDetailView | undefined> => {
    const repository = new PlatformSkillCatalogRepository(this.db);
    const draft = draftView(await repository.getSkill(id));
    if (!draft) return undefined;
    const versions = (await repository.listVersions(id)).map(versionView);
    return {
      baseRevision: draft.revision,
      draft,
      draftToken: platformSkillDraftToken(draft, versions),
      publishedVersion: versions.find((version) => version.id === draft.currentVersionId) ?? null,
      versions,
    };
  };

  listSkills = async (params: Parameters<PlatformSkillCatalogRepository['listSkills']>[0]) => {
    const page = await new PlatformSkillCatalogRepository(this.db).listSkills(params);
    return {
      items: page.items.map((item) => draftView(item)!),
      nextCursor: page.nextCursor,
    };
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
      await repository.updateSkill(params.id, {
        description: params.description,
        distribution: params.distribution,
        enabled: params.enabled,
        name: params.displayName,
        status: 'draft',
        updatedBy: params.actorUserId,
      });
      return new PlatformSkillCatalogModel(tx, this.options).getDetail(params.id);
    });
  };
}
