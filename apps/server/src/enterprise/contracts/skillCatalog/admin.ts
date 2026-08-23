import { z } from 'zod';

import {
  boundedSafeText,
  cursorSchema,
  draftTokenSchema,
  optionalReasonSchema,
  reasonSchema,
  revisionSchema,
  skillContentRefSchema,
  skillKeySchema,
  skillVersionSchema,
} from './common';
import {
  immutableSkillVersionSchema,
  skillIdentityDraftSchema,
  skillVersionSummarySchema,
} from './identity';
import { skillManifestSchema, skillValidationResultSchema } from './manifest';
import { skillResourcesSchema } from './resources';

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
    reason: optionalReasonSchema,
    skillKey: skillKeySchema,
  })
  .strict();

export const adminSkillUpdateDraftInputSchema = skillIdentityFieldsSchema
  .extend({
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    id: z.string().min(1),
    reason: optionalReasonSchema,
  })
  .strict();

export const adminSkillCreateVersionInputSchema = z
  .object({
    content: z.string().min(1).max(1_048_576),
    contentRef: skillContentRefSchema.nullable().default(null),
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    manifest: skillManifestSchema,
    reason: optionalReasonSchema,
    resources: skillResourcesSchema.default([]),
    skillId: z.string().min(1),
    version: skillVersionSchema,
  })
  .strict();

export const adminSkillValidateInputSchema = z
  .object({
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    reason: optionalReasonSchema,
    skillId: z.string().min(1),
    versionId: z.string().min(1),
  })
  .strict();

const skillPublicationInputSchema = z
  .object({
    expectedDraftToken: draftTokenSchema,
    expectedRevision: revisionSchema,
    id: z.string().min(1),
    reason: optionalReasonSchema,
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

export type AdminSkillApplyImmediateInput = z.infer<typeof adminSkillApplyImmediateInputSchema>;
export type AdminSkillApplyImmediateOutput = z.infer<typeof adminSkillApplyImmediateOutputSchema>;
export type AdminSkillCreateInput = z.infer<typeof adminSkillCreateInputSchema>;
export type AdminSkillCreateVersionInput = z.infer<typeof adminSkillCreateVersionInputSchema>;
export type AdminSkillPublishNowInput = z.infer<typeof adminSkillPublishNowInputSchema>;
export type AdminSkillUpdateDraftInput = z.infer<typeof adminSkillUpdateDraftInputSchema>;
