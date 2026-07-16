import { z } from 'zod';

const skillKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const skillVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?(?:\+[0-9A-Z.-]+)?$/i);

const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const reasonSchema = z.string().trim().min(1).max(2000);
const draftTokenSchema = z.string().length(64);
const revisionSchema = z.number().int().nonnegative();
const cursorSchema = z.string().min(1).max(1000);
const localizedTextSchema = z.record(
  z.string().trim().min(2).max(35),
  z.string().trim().min(1).max(4000),
);

export const skillToolDependencySchema = z
  .object({
    optional: z.boolean().default(false),
    toolKey: z.string().trim().min(1).max(128),
  })
  .strict();

export const skillSkillDependencySchema = z
  .object({
    optional: z.boolean().default(false),
    skillKey: skillKeySchema,
    version: skillVersionSchema,
  })
  .strict();

export const skillManifestSchema = z
  .object({
    description: z.string().trim().min(1).max(4000),
    displayName: z.string().trim().min(1).max(200),
    localizedDescriptions: localizedTextSchema.default({}),
    localizedDisplayNames: localizedTextSchema.default({}),
    networkAccess: z.boolean().default(false),
    skillDependencies: z.array(skillSkillDependencySchema).max(100).default([]),
    toolDependencies: z.array(skillToolDependencySchema).max(100).default([]),
  })
  .strict();

export const skillValidationIssueCodeSchema = z.enum([
  'builtin_override_forbidden',
  'checksum_mismatch',
  'content_too_large',
  'dangerous_instruction',
  'dependency_cycle',
  'manifest_invalid',
  'permissions_invalid',
  'unknown_skill_dependency',
  'unknown_tool_dependency',
  'version_conflict',
]);

export const skillValidationIssueSchema = z
  .object({
    code: skillValidationIssueCodeSchema,
    message: z.string().max(500),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).max(32),
    severity: z.enum(['error', 'warning']),
  })
  .strict();

export const skillValidationResultSchema = z
  .object({
    issues: z.array(skillValidationIssueSchema).max(500),
    validatedAt: z.date(),
    validatorVersion: z.string().min(1).max(64),
  })
  .strict();

export const skillIdentityDraftSchema = z
  .object({
    currentVersionId: z.string().min(1).nullable(),
    description: z.string().trim().max(4000).nullable(),
    displayName: z.string().trim().min(1).max(200),
    distribution: z.enum(['mandatory', 'default', 'optional']),
    enabled: z.boolean(),
    id: z.string().min(1),
    revision: revisionSchema,
    skillKey: skillKeySchema,
    source: z.enum(['builtin', 'uploaded']),
    status: z.enum(['draft', 'published', 'archived']),
  })
  .strict();

export const immutableSkillVersionSchema = z
  .object({
    checksum: checksumSchema,
    content: z.string().min(1).max(1_048_576),
    contentRef: z.string().max(2000).nullable(),
    createdAt: z.date(),
    createdBy: z.string().min(1).nullable(),
    id: z.string().min(1),
    manifest: skillManifestSchema,
    skillId: z.string().min(1),
    validation: skillValidationResultSchema.nullable(),
    version: skillVersionSchema,
  })
  .strict();

export const adminSkillListInputSchema = z
  .object({
    cursor: cursorSchema.optional(),
    distribution: z.enum(['mandatory', 'default', 'optional']).optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().min(1).max(200).optional(),
    source: z.enum(['builtin', 'uploaded']).optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
  })
  .strict();

export const adminSkillListOutputSchema = z
  .object({
    items: z.array(skillIdentityDraftSchema),
    nextCursor: cursorSchema.nullable(),
  })
  .strict();

export const adminSkillGetInputSchema = z.object({ id: z.string().min(1) }).strict();

export const adminSkillGetOutputSchema = z
  .object({
    baseRevision: revisionSchema,
    draft: skillIdentityDraftSchema,
    draftToken: draftTokenSchema,
    publishedVersion: immutableSkillVersionSchema.nullable(),
    versions: z.array(immutableSkillVersionSchema),
  })
  .strict();

const skillIdentityFieldsSchema = z
  .object({
    description: z.string().trim().max(4000).nullable().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    distribution: z.enum(['mandatory', 'default', 'optional']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const adminSkillCreateInputSchema = skillIdentityFieldsSchema
  .extend({
    displayName: z.string().trim().min(1).max(200),
    reason: reasonSchema,
    skillKey: skillKeySchema,
    source: z.enum(['builtin', 'uploaded']).default('uploaded'),
  })
  .strict();

export const adminSkillUpdateDraftInputSchema = skillIdentityFieldsSchema
  .extend({
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    id: z.string().min(1),
    reason: reasonSchema,
  })
  .strict();

export const adminSkillCreateVersionInputSchema = z
  .object({
    checksum: checksumSchema,
    content: z.string().min(1).max(1_048_576),
    contentRef: z.string().trim().max(2000).nullable().default(null),
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    manifest: skillManifestSchema,
    reason: reasonSchema,
    skillId: z.string().min(1),
    version: skillVersionSchema,
  })
  .strict();

export const adminSkillValidateInputSchema = z
  .object({
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: reasonSchema,
    skillId: z.string().min(1),
    versionId: z.string().min(1),
  })
  .strict();

const skillPublicationInputSchema = z
  .object({
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    id: z.string().min(1),
    reason: reasonSchema,
  })
  .strict();

export const adminSkillPublishInputSchema = skillPublicationInputSchema
  .extend({ versionId: z.string().min(1) })
  .strict();

export const adminSkillArchiveInputSchema = skillPublicationInputSchema;

export const adminSkillRollbackInputSchema = skillPublicationInputSchema
  .extend({ targetVersionId: z.string().min(1) })
  .strict();

export const adminSkillGetDependentsInputSchema = z
  .object({ skillId: z.string().min(1), versionId: z.string().min(1).optional() })
  .strict();

export const skillDependentSchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    type: z.enum(['agent', 'skill']),
    version: z.string().min(1).max(64),
  })
  .strict();

export const adminSkillGetDependentsOutputSchema = z
  .object({ items: z.array(skillDependentSchema).max(1000) })
  .strict();

export const adminSkillMutationOutputSchema = z
  .object({
    draft: skillIdentityDraftSchema,
    draftToken: draftTokenSchema,
  })
  .strict();

export const publishedSkillSchema = z
  .object({
    checksum: checksumSchema,
    content: z.string().min(1).max(1_048_576),
    description: z.string().max(4000).nullable(),
    displayName: z.string().min(1).max(200),
    distribution: z.enum(['mandatory', 'default', 'optional']),
    manifest: skillManifestSchema,
    skillKey: skillKeySchema,
    source: z.enum(['builtin', 'uploaded']),
    version: skillVersionSchema,
  })
  .strict();

export const publishedSkillCatalogSchema = z
  .object({
    revision: z.string().min(1).max(200),
    skills: z.array(publishedSkillSchema),
  })
  .strict();

export const serverSkillResolveInputSchema = z
  .object({ skillKey: skillKeySchema, version: skillVersionSchema.optional() })
  .strict();

/** Server-only execution projection. Never return this schema from a public/admin router. */
export const serverResolvedSkillSchema = publishedSkillSchema
  .extend({
    contentRef: z.string().max(2000).nullable(),
    skillId: z.string().min(1),
    versionId: z.string().min(1),
  })
  .strict();

export type AdminSkillCreateInput = z.infer<typeof adminSkillCreateInputSchema>;
export type AdminSkillCreateVersionInput = z.infer<typeof adminSkillCreateVersionInputSchema>;
export type AdminSkillUpdateDraftInput = z.infer<typeof adminSkillUpdateDraftInputSchema>;
export type ImmutableSkillVersion = z.infer<typeof immutableSkillVersionSchema>;
export type PublishedSkill = z.infer<typeof publishedSkillSchema>;
export type SkillIdentityDraft = z.infer<typeof skillIdentityDraftSchema>;
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillValidationIssue = z.infer<typeof skillValidationIssueSchema>;
export type SkillValidationResult = z.infer<typeof skillValidationResultSchema>;
