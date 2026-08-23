import type { PlatformSkillDetailView, PlatformSkillVersionView } from '@/database/models/platform';
import type { PlatformSkillValidationResult } from '@/database/schemas/platform';

import type { ImmutableSkillVersion, SkillValidationResult } from '../../contracts/skillCatalog';

export const validationView = (
  validation: PlatformSkillVersionView['validation'],
): SkillValidationResult | null => {
  if (!validation) return null;
  return {
    ...validation,
    validatedAt: new Date(validation.validatedAt),
  };
};

/** Persist validation with ISO string timestamps (DB jsonb shape). */
export const toStoredValidation = (
  validation: SkillValidationResult,
): PlatformSkillValidationResult => ({
  issues: validation.issues,
  validatedAt: validation.validatedAt.toISOString(),
  validatorVersion: validation.validatorVersion,
});

export const versionView = (version: PlatformSkillVersionView): ImmutableSkillVersion => ({
  ...version,
  validation: validationView(version.validation),
});

export const versionSummary = (
  version: PlatformSkillVersionView,
  lastPublishedRevision: number | null = null,
) => ({
  checksum: version.checksum,
  createdAt: version.createdAt,
  createdBy: version.createdBy,
  id: version.id,
  lastPublishedRevision,
  skillId: version.skillId,
  validation: validationView(version.validation),
  version: version.version,
});

export const detailOutput = (
  detail: PlatformSkillDetailView,
  publishedRevisions: ReadonlyMap<string, number>,
) => ({
  baseRevision: detail.baseRevision,
  draft: detail.draft,
  draftToken: detail.draftToken,
  latestVersion: detail.latestVersion
    ? versionSummary(detail.latestVersion, publishedRevisions.get(detail.latestVersion.id) ?? null)
    : null,
  publishedVersion: detail.publishedVersion
    ? versionSummary(
        detail.publishedVersion,
        publishedRevisions.get(detail.publishedVersion.id) ?? null,
      )
    : null,
});
