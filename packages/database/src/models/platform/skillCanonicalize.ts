import { createHash } from 'node:crypto';

import type {
  PlatformPublishedSkillRow,
  PlatformPublishedSkillSnapshot,
  PlatformSkillCatalogRepository,
} from '../../repositories/platformSkillCatalog';
import type {
  PlatformDistribution,
  PlatformResourceStatus,
  PlatformSkillManifest,
  PlatformSkillResource,
  PlatformSkillSource,
  PlatformSkillValidationResult,
} from '../../schemas/platform';
import { checksumPayload } from './checksum';

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

export interface PlatformPublishedSkillView {
  allowBuiltinOverride: boolean;
  description: string | null;
  displayName: string;
  distribution: PlatformDistribution;
  revision: number;
  skillId: string;
  skillKey: string;
  source: PlatformSkillSource;
  version: PlatformSkillVersionView;
}

export interface PlatformPublishedSkillPageView {
  builtinOverrideTombstones: string[];
  catalogTokenEntries?: PlatformSkillCatalogTokenEntryView[];
  items: PlatformPublishedSkillView[];
  nextCursor: string | null;
}

export interface PlatformSkillCatalogTokenEntryView {
  checksum: string;
  currentVersionId: string;
  revision: number;
  skillId: string;
  skillKey: string;
  tombstone: boolean;
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

export const draftView = (row: Awaited<ReturnType<PlatformSkillCatalogRepository['getSkill']>>) => {
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

export const versionView = (
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

export const parsePlatformPublishedSkillSnapshot = (
  value: unknown,
): PlatformPublishedSkillSnapshot | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PlatformPublishedSkillSnapshot>;
  if (!candidate.skill || typeof candidate.skill !== 'object' || Array.isArray(candidate.skill)) {
    return undefined;
  }
  const skill = candidate.skill as Partial<PlatformPublishedSkillSnapshot['skill']>;
  if (
    (candidate.builtinOverrideTombstone !== undefined &&
      candidate.builtinOverrideTombstone !== true) ||
    typeof candidate.versionId !== 'string' ||
    typeof skill.allowBuiltinOverride !== 'boolean' ||
    (skill.description !== null && typeof skill.description !== 'string') ||
    typeof skill.displayName !== 'string' ||
    !['default', 'mandatory', 'optional'].includes(skill.distribution ?? '') ||
    typeof skill.enabled !== 'boolean' ||
    typeof skill.skillKey !== 'string' ||
    !['builtin', 'uploaded'].includes(skill.source ?? '')
  ) {
    return undefined;
  }
  return candidate as PlatformPublishedSkillSnapshot;
};

export const publishedView = (
  row: PlatformPublishedSkillRow,
  payload = parsePlatformPublishedSkillSnapshot(row.payload),
): PlatformPublishedSkillView | undefined => {
  if (
    row.status !== 'published' ||
    !payload ||
    payload.versionId !== row.version.id ||
    row.skillId !== row.version.skillId ||
    !payload.skill.enabled
  ) {
    return undefined;
  }
  return {
    allowBuiltinOverride: payload.skill.allowBuiltinOverride,
    description: payload.skill.description,
    displayName: payload.skill.displayName,
    distribution: payload.skill.distribution,
    revision: row.revision,
    skillId: row.skillId,
    skillKey: payload.skill.skillKey,
    source: payload.skill.source,
    version: versionView(row.version),
  };
};

export const buildPublishedSnapshot = (
  draft: PlatformSkillDraftView,
  versionId: string,
): PlatformPublishedSkillSnapshot => ({
  skill: {
    allowBuiltinOverride: draft.allowBuiltinOverride,
    description: draft.description,
    displayName: draft.displayName,
    distribution: draft.distribution,
    enabled: draft.enabled,
    skillKey: draft.skillKey,
    source: draft.source,
  },
  versionId,
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

/**
 * Canonicalize resource text and recompute sizeBytes/checksum from the canonical
 * UTF-8 bytes so stored metadata cannot drift after CRLF/NFD normalization.
 */
export const canonicalizePlatformSkillResources = (
  resources: PlatformSkillResource[],
): PlatformSkillResource[] =>
  resources
    .map((resource) => {
      const content =
        resource.content === undefined
          ? undefined
          : canonicalizePlatformSkillContent(resource.content);
      const contentRef =
        resource.contentRef === undefined
          ? undefined
          : canonicalizePlatformSkillContent(resource.contentRef);
      const mediaType = canonicalizePlatformSkillContent(resource.mediaType);
      const path = canonicalizePlatformSkillContent(resource.path);
      if (content === undefined) {
        return {
          ...resource,
          content,
          contentRef,
          mediaType,
          path,
        };
      }
      const bytes = Buffer.from(content, 'utf8');
      return {
        ...resource,
        checksum: createHash('sha256').update(bytes).digest('hex'),
        content,
        contentRef,
        mediaType,
        path,
        sizeBytes: bytes.byteLength,
      };
    })
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
