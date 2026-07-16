import { PlatformSkillCatalogRepository } from '../../repositories/platformSkillCatalog';
import type {
  PlatformDistribution,
  PlatformResourceStatus,
  PlatformSkillManifest,
  PlatformSkillResource,
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
  draftSequence: number;
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
  resources: PlatformSkillResource[];
  skillId: string;
  validation: PlatformSkillValidationResult | null;
  version: string;
}

export interface PlatformSkillDetailView {
  baseRevision: number;
  draft: PlatformSkillDraftView;
  draftToken: string;
  latestVersion: PlatformSkillVersionView | null;
  publishedVersion: PlatformSkillVersionView | null;
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
    super('Skill version checksum does not match its canonical immutable execution payload');
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
    draftSequence: row.draftSequence,
    enabled: row.enabled,
    id: row.id,
    revision: row.revision,
    skillKey: row.skillKey,
    source: row.source,
    status: row.status,
  } satisfies PlatformSkillDraftView;
};

const versionView = (
  row: NonNullable<Awaited<ReturnType<PlatformSkillCatalogRepository['getVersion']>>>,
): PlatformSkillVersionView => ({
  checksum: row.checksum,
  content: row.content,
  contentRef: row.contentRef ?? null,
  createdAt: row.createdAt,
  createdBy: row.createdBy ?? null,
  id: row.id,
  manifest: row.manifest,
  resources: row.resources,
  skillId: row.skillId,
  validation: row.validationResult ?? null,
  version: row.version,
});

export const canonicalizePlatformSkillContent = (value: string) =>
  value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFC');

export const canonicalizePlatformSkillManifest = (
  manifest: PlatformSkillManifest,
): PlatformSkillManifest => ({
  description: canonicalizePlatformSkillContent(manifest.description),
  displayName: canonicalizePlatformSkillContent(manifest.displayName),
  localizedDescriptions: Object.fromEntries(
    Object.entries(manifest.localizedDescriptions)
      .map(
        ([locale, value]) =>
          [
            canonicalizePlatformSkillContent(locale),
            canonicalizePlatformSkillContent(value),
          ] as const,
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ),
  localizedDisplayNames: Object.fromEntries(
    Object.entries(manifest.localizedDisplayNames)
      .map(
        ([locale, value]) =>
          [
            canonicalizePlatformSkillContent(locale),
            canonicalizePlatformSkillContent(value),
          ] as const,
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ),
  permissions: {
    filesystem: manifest.permissions.filesystem,
    network: {
      allowedHosts: manifest.permissions.network.allowedHosts
        .map(canonicalizePlatformSkillContent)
        .sort(),
      enabled: manifest.permissions.network.enabled,
    },
    tools: { allow: manifest.permissions.tools.allow.map(canonicalizePlatformSkillContent).sort() },
  },
  skillDependencies: manifest.skillDependencies.map((dependency) => ({
    ...dependency,
    skillKey: canonicalizePlatformSkillContent(dependency.skillKey),
    version: canonicalizePlatformSkillContent(dependency.version),
  })),
  toolDependencies: manifest.toolDependencies.map((dependency) => ({
    ...dependency,
    toolKey: canonicalizePlatformSkillContent(dependency.toolKey),
  })),
});

export const canonicalizePlatformSkillResources = (
  resources: PlatformSkillResource[],
): PlatformSkillResource[] =>
  resources
    .map((resource) => ({
      ...resource,
      content:
        resource.content === undefined
          ? undefined
          : canonicalizePlatformSkillContent(resource.content),
      contentRef:
        resource.contentRef === undefined
          ? undefined
          : canonicalizePlatformSkillContent(resource.contentRef),
      mediaType: canonicalizePlatformSkillContent(resource.mediaType),
      path: canonicalizePlatformSkillContent(resource.path),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

export const platformSkillVersionChecksum = (params: {
  content: string;
  contentRef?: string | null;
  manifest: PlatformSkillManifest;
  resources?: PlatformSkillResource[];
}) => {
  const canonical = {
    content: canonicalizePlatformSkillContent(params.content),
    contentRef: params.contentRef ? canonicalizePlatformSkillContent(params.contentRef) : null,
    manifest: canonicalizePlatformSkillManifest(params.manifest),
    resources: canonicalizePlatformSkillResources(params.resources ?? []),
  };
  return checksumPayload(canonical);
};

export const platformSkillDraftToken = (draft: PlatformSkillDraftView) =>
  checksumPayload({ draft });

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
}
