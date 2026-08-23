/**
 * Strict Zod contracts for the managed Skill catalog (admin + published + runtime).
 *
 * Implementation is split by subdomain under `./skillCatalog/`; this file is the stable
 * public barrel so existing `.../contracts/skillCatalog` import paths remain valid.
 */

export {
  type AdminSkillApplyImmediateInput,
  adminSkillApplyImmediateInputSchema,
  type AdminSkillApplyImmediateOutput,
  adminSkillApplyImmediateOutputSchema,
  adminSkillArchiveInputSchema,
  type AdminSkillCreateInput,
  adminSkillCreateInputSchema,
  type AdminSkillCreateVersionInput,
  adminSkillCreateVersionInputSchema,
  adminSkillCreateVersionOutputSchema,
  adminSkillGetDependentsInputSchema,
  adminSkillGetDependentsOutputSchema,
  adminSkillGetInputSchema,
  adminSkillGetOutputSchema,
  adminSkillGetVersionInputSchema,
  adminSkillGetVersionOutputSchema,
  adminSkillListInputSchema,
  adminSkillListOutputSchema,
  adminSkillListVersionsInputSchema,
  adminSkillListVersionsOutputSchema,
  adminSkillMutationOutputSchema,
  adminSkillPublicationOutputSchema,
  adminSkillPublishInputSchema,
  type AdminSkillPublishNowInput,
  adminSkillPublishNowInputSchema,
  adminSkillRollbackInputSchema,
  type AdminSkillUpdateDraftInput,
  adminSkillUpdateDraftInputSchema,
  adminSkillValidateInputSchema,
  adminSkillValidateOutputSchema,
  skillDependentSchema,
} from './skillCatalog/admin';
export {
  type ImmutableSkillVersion,
  immutableSkillVersionSchema,
  skillIdentityDraftSchema,
  skillVersionSummarySchema,
} from './skillCatalog/identity';
export {
  type AdminSkillParseImportSourceInput,
  adminSkillParseImportSourceInputSchema,
  type AdminSkillParseImportSourceOutput,
  adminSkillParseImportSourceOutputSchema,
} from './skillCatalog/import';
export {
  type SkillManifest,
  skillManifestSchema,
  skillPermissionsSchema,
  skillSkillDependencySchema,
  skillToolDependencySchema,
  type SkillValidationIssue,
  skillValidationIssueCodeSchema,
  skillValidationIssueSchema,
  type SkillValidationResult,
  skillValidationResultSchema,
} from './skillCatalog/manifest';
export {
  type SkillResource,
  skillResourceContentChecksum,
  skillResourceSchema,
} from './skillCatalog/resources';
export {
  beginPlatformSkillOperationInputSchema,
  platformSkillOperationProofSchema,
  type PlatformSkillPinnedRef,
  platformSkillPinnedRefSchema,
  type PublishedSkill,
  publishedSkillCatalogSchema,
  publishedSkillSchema,
  resolvePlatformSkillPinnedInputSchema,
  serverResolvedSkillSchema,
} from './skillCatalog/runtime';
