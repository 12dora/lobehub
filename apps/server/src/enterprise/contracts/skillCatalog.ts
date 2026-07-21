import semver from 'semver';
import { z } from 'zod';

import { containsEnterpriseSecretMaterial } from '../security/redaction';

const rejectSensitiveText = (value: string, ctx: z.RefinementCtx) => {
  if (containsEnterpriseSecretMaterial(value)) {
    ctx.addIssue({ code: 'custom', message: 'secret material is not allowed' });
  }
};

const boundedSafeText = (max: number) =>
  z.string().trim().min(1).max(max).superRefine(rejectSensitiveText);

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
  .refine((value) => semver.valid(value) === value, 'version must be valid SemVer');

const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const reasonSchema = boundedSafeText(2000);
const draftTokenSchema = z.string().length(64);
const revisionSchema = z.number().int().nonnegative();
const cursorSchema = z.string().min(1).max(1000);
const localizedTextSchema = z.record(z.string().trim().min(2).max(35), boundedSafeText(4000));
const skillContentRefSchema = z
  .string()
  .trim()
  .min(8)
  .max(520)
  .regex(/^opaque:[a-z0-9][\w./-]*$/i);
const skillResourcePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'resource path must be a normalized relative POSIX path',
  );

export const skillResourceSchema = z
  .object({
    checksum: checksumSchema,
    content: z.string().max(1_048_576).optional(),
    contentRef: skillContentRefSchema.optional(),
    mediaType: z
      .string()
      .trim()
      .min(3)
      .max(127)
      .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
    path: skillResourcePathSchema,
    sizeBytes: z.number().int().nonnegative().max(1_048_576),
  })
  .strict()
  .superRefine((resource, ctx) => {
    if ((resource.content === undefined) === (resource.contentRef === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'resource must contain exactly one of content or contentRef',
      });
    }
    if (
      resource.content !== undefined &&
      new TextEncoder().encode(resource.content).byteLength !== resource.sizeBytes
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'resource sizeBytes must match UTF-8 content bytes',
      });
    }
  });

const skillResourcesSchema = z.array(skillResourceSchema).max(100);

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

export const skillPermissionsSchema = z
  .object({
    filesystem: z.enum(['none', 'read']).default('none'),
    network: z
      .object({
        allowedHosts: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(253)
              .regex(
                /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
              ),
          )
          .max(50),
        enabled: z.boolean(),
      })
      .strict()
      .default({ allowedHosts: [], enabled: false }),
    tools: z
      .object({ allow: z.array(z.string().trim().min(1).max(128)).max(100) })
      .strict()
      .default({ allow: [] }),
  })
  .strict();

export const skillManifestSchema = z
  .object({
    description: boundedSafeText(4000),
    displayName: boundedSafeText(200),
    localizedDescriptions: localizedTextSchema.default({}),
    localizedDisplayNames: localizedTextSchema.default({}),
    permissions: skillPermissionsSchema,
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
  'dependency_graph_limit',
  'dependency_identity_mismatch',
  'dependency_resolver_error',
  'manifest_invalid',
  'permissions_invalid',
  'secret_material_detected',
  'unknown_skill_dependency',
  'unknown_tool_dependency',
  'version_conflict',
]);

export const skillValidationIssueSchema = z
  .object({
    code: skillValidationIssueCodeSchema,
    message: boundedSafeText(500),
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
    allowBuiltinOverride: z.boolean(),
    currentVersionId: z.string().min(1).nullable(),
    description: boundedSafeText(4000).nullable(),
    displayName: boundedSafeText(200),
    distribution: z.enum(['mandatory', 'default', 'optional']),
    draftSequence: z.number().int().nonnegative(),
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
    contentRef: skillContentRefSchema.nullable(),
    createdAt: z.date(),
    createdBy: z.string().min(1).nullable(),
    id: z.string().min(1),
    manifest: skillManifestSchema,
    resources: skillResourcesSchema,
    skillId: z.string().min(1),
    validation: skillValidationResultSchema.nullable(),
    version: skillVersionSchema,
  })
  .strict();

export const skillVersionSummarySchema = immutableSkillVersionSchema
  .omit({ content: true, contentRef: true, manifest: true, resources: true })
  .extend({ lastPublishedRevision: z.number().int().positive().nullable() })
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
    items: z.array(skillIdentityDraftSchema).max(100),
    nextCursor: cursorSchema.nullable(),
  })
  .strict();

export const adminSkillGetInputSchema = z.object({ id: z.string().min(1) }).strict();

export const adminSkillGetOutputSchema = z
  .object({
    baseRevision: revisionSchema,
    draft: skillIdentityDraftSchema,
    draftToken: draftTokenSchema,
    latestVersion: skillVersionSummarySchema.nullable(),
    publishedVersion: skillVersionSummarySchema.nullable(),
  })
  .strict();

export const adminSkillListVersionsInputSchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    skillId: z.string().min(1),
  })
  .strict();

export const adminSkillListVersionsOutputSchema = z
  .object({
    items: z.array(skillVersionSummarySchema).max(100),
    nextCursor: cursorSchema.nullable(),
  })
  .strict();

export const adminSkillGetVersionInputSchema = z
  .object({ skillId: z.string().min(1), versionId: z.string().min(1) })
  .strict();

export const adminSkillGetVersionOutputSchema = immutableSkillVersionSchema;

const skillIdentityFieldsSchema = z
  .object({
    description: boundedSafeText(4000).nullable().optional(),
    displayName: boundedSafeText(200).optional(),
    distribution: z.enum(['mandatory', 'default', 'optional']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const adminSkillCreateInputSchema = skillIdentityFieldsSchema
  .extend({
    allowBuiltinOverride: z.boolean().default(false),
    displayName: boundedSafeText(200),
    reason: reasonSchema,
    skillKey: skillKeySchema,
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
    content: z.string().min(1).max(1_048_576),
    contentRef: skillContentRefSchema.nullable().default(null),
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    manifest: skillManifestSchema,
    reason: reasonSchema,
    resources: skillResourcesSchema.default([]),
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
  .object({
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    skillId: z.string().min(1),
    versionId: z.string().min(1).optional(),
  })
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
  .object({
    items: z.array(skillDependentSchema).max(100),
    nextCursor: cursorSchema.nullable(),
  })
  .strict();

export const adminSkillMutationOutputSchema = z
  .object({
    draft: skillIdentityDraftSchema,
    draftToken: draftTokenSchema,
  })
  .strict();

export const adminSkillCreateVersionOutputSchema = immutableSkillVersionSchema;
export const adminSkillValidateOutputSchema = skillValidationResultSchema;

export const adminSkillPublicationOutputSchema = z
  .object({
    auditId: z.string().min(1),
    catalogRevision: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    skillId: z.string().min(1),
    status: z.enum(['published', 'archived']),
    versionId: z.string().min(1).nullable(),
  })
  .strict();

/** Draft mutation + immediate publish (admin UI parity; single rate-limit unit). */
export const adminSkillApplyImmediateOutputSchema = z
  .object({
    auditId: z.string().min(1).nullable(),
    draft: skillIdentityDraftSchema,
    draftToken: draftTokenSchema,
    /**
     * false when draft was written but publish validation blocked first publish
     * (e.g. create without version / invalid version). Client must not treat as silent live success.
     */
    published: z.boolean(),
    /** Structured human-safe reason when published is false (never secrets). */
    publishError: z.string().max(500).nullable().optional(),
    revision: z.number().int().nonnegative(),
    versionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export const adminSkillPublishNowInputSchema = z
  .object({
    id: z.string().min(1),
    reason: reasonSchema,
    /** When omitted, uses latestVersion or currentVersionId. */
    versionId: z.string().min(1).optional(),
  })
  .strict();

const skillApplyVersionPayloadSchema = z
  .object({
    content: z.string().min(1).max(1_048_576),
    contentRef: skillContentRefSchema.nullable().default(null),
    manifest: skillManifestSchema,
    resources: skillResourcesSchema.default([]),
    version: skillVersionSchema,
  })
  .strict();

export const adminSkillApplyImmediateInputSchema = z.discriminatedUnion('mode', [
  adminSkillCreateInputSchema
    .extend({
      mode: z.literal('create'),
      /** Optional version payload so import can create + publish in one shot. */
      version: skillApplyVersionPayloadSchema.optional(),
    })
    .strict(),
  adminSkillUpdateDraftInputSchema
    .extend({
      mode: z.literal('update'),
      /** Version to publish after identity update; defaults to latest / current. */
      versionId: z.string().min(1).optional(),
    })
    .strict(),
  adminSkillCreateVersionInputSchema
    .extend({
      mode: z.literal('createVersion'),
    })
    .strict(),
]);

export const publishedSkillSchema = z
  .object({
    checksum: checksumSchema,
    description: boundedSafeText(4000).nullable(),
    displayName: boundedSafeText(200),
    distribution: z.enum(['mandatory', 'default', 'optional']),
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

export const platformSkillPinnedRefSchema = z
  .object({
    checksum: checksumSchema,
    skillKey: skillKeySchema,
    version: skillVersionSchema,
  })
  .strict();

export const platformSkillOperationProofSchema = z
  .object({
    agentId: z.string().min(1).max(256),
    operationId: z.string().min(1).max(256),
    proof: z.string().min(1).max(8192),
    refs: z.array(platformSkillPinnedRefSchema).max(10_000),
    revision: z.string().min(1).max(200),
  })
  .strict();

export const beginPlatformSkillOperationInputSchema = platformSkillOperationProofSchema
  .omit({ proof: true })
  .strict();

export const resolvePlatformSkillPinnedInputSchema = z
  .object({
    operation: platformSkillOperationProofSchema.optional(),
    ref: platformSkillPinnedRefSchema,
  })
  .strict();

export const serverSkillResolveInputSchema = z
  .object({ skillKey: skillKeySchema, version: skillVersionSchema.optional() })
  .strict();

/** Server-only execution projection. Never return this schema from a public/admin router. */
export const serverResolvedSkillSchema = publishedSkillSchema
  .extend({
    allowBuiltinOverride: z.boolean(),
    content: z.string().min(1).max(1_048_576),
    contentRef: skillContentRefSchema.nullable(),
    manifest: skillManifestSchema,
    resources: skillResourcesSchema,
    skillId: z.string().min(1),
    versionId: z.string().min(1),
  })
  .strict();

export type AdminSkillApplyImmediateInput = z.infer<typeof adminSkillApplyImmediateInputSchema>;
export type AdminSkillApplyImmediateOutput = z.infer<typeof adminSkillApplyImmediateOutputSchema>;
export type AdminSkillCreateInput = z.infer<typeof adminSkillCreateInputSchema>;
export type AdminSkillCreateVersionInput = z.infer<typeof adminSkillCreateVersionInputSchema>;
export type AdminSkillPublishNowInput = z.infer<typeof adminSkillPublishNowInputSchema>;
export type AdminSkillUpdateDraftInput = z.infer<typeof adminSkillUpdateDraftInputSchema>;
export type ImmutableSkillVersion = z.infer<typeof immutableSkillVersionSchema>;
export type PlatformSkillPinnedRef = z.infer<typeof platformSkillPinnedRefSchema>;
export type PublishedSkill = z.infer<typeof publishedSkillSchema>;
export type SkillResource = z.infer<typeof skillResourceSchema>;
export type SkillIdentityDraft = z.infer<typeof skillIdentityDraftSchema>;
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillValidationIssue = z.infer<typeof skillValidationIssueSchema>;
export type SkillValidationResult = z.infer<typeof skillValidationResultSchema>;
