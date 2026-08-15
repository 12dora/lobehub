/**
 * Strict contracts for `admin.settings.*` (M05).
 */

import { z } from 'zod';

import { secretSafeAuditReasonSchema, secretSafeOptionalCommentSchema } from './shared';

const settingsAuditReasonSchema = secretSafeAuditReasonSchema;

export const settingPolicyModeSchema = z.enum(['user', 'default', 'locked']);
export const settingPolicyVisibilitySchema = z.enum(['visible', 'hidden']);

export const settingDraftPolicySchema = z
  .object({
    mode: settingPolicyModeSchema,
    schemaVersion: z.number().int().positive(),
    value: z.unknown().optional(),
    visibility: settingPolicyVisibilitySchema,
  })
  .strict();

export const adminSettingsGetDraftOutputSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  draft: z.record(settingDraftPolicySchema),
  draftToken: z.string().length(64),
  publishedPolicies: z.record(settingDraftPolicySchema),
  registry: z.array(
    z.object({
      builtInDefault: z.unknown().optional(),
      control: z.string(),
      descriptionKey: z.string(),
      group: z.string(),
      max: z.number().optional(),
      min: z.number().optional(),
      options: z
        .array(
          z.object({ labelKey: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }),
        )
        .optional(),
      path: z.string(),
      schemaVersion: z.number().int(),
      step: z.number().optional(),
      titleKey: z.string(),
    }),
  ),
  registryVersion: z.number().int(),
  status: z.enum(['draft', 'published', 'archived']),
});

/**
 * Immediate site-wide settings-policy write (de-drafted 统一管理 surface).
 *
 * `policies` carries ONLY policy-editor-owned paths — service-model paths
 * (`image.*`, `systemAgent.*`, `defaultAgent.config.model|provider`, `tts.openAI.ttsModel`)
 * are ignored server-side and their published rows preserved. An empty `policies`
 * map therefore means "restore defaults for owned paths only", never a whole-table wipe.
 *
 * CAS: `expectedRevision` guards the published pointer, `expectedDraftToken` the bundle.
 * A stale base fails with PLATFORM_REVISION_CONFLICT (the client refreshes).
 */
export const adminSettingsSaveInputSchema = z
  .object({
    comment: secretSafeOptionalCommentSchema,
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    policies: z.record(settingDraftPolicySchema),
    reason: settingsAuditReasonSchema,
  })
  .strict();

export const adminSettingsSaveOutputSchema = z.object({
  auditId: z.string(),
  draftToken: z.string().length(64),
  revision: z.number().int().positive(),
  /** Non-fatal machine-readable notes, e.g. `ignored_service_model_paths:3`. */
  warnings: z.array(z.string()).optional(),
});

/**
 * Merge a path→value patch into the settings draft and publish immediately.
 * Rejects when the draft has unpublished diffs outside the patch paths.
 */
export const adminSettingsApplyImmediateInputSchema = z
  .object({
    patch: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0, {
      message: 'patch must include at least one path',
    }),
    reason: settingsAuditReasonSchema.optional(),
  })
  .strict();

export const adminSettingsApplyImmediateOutputSchema = z.object({
  auditId: z.string(),
  draftToken: z.string().length(64),
  paths: z.array(z.string()),
  revision: z.number().int().positive(),
});

export type AdminSettingsGetDraftOutput = z.infer<typeof adminSettingsGetDraftOutputSchema>;
export type AdminSettingsSaveInput = z.infer<typeof adminSettingsSaveInputSchema>;
export type AdminSettingsSaveOutput = z.infer<typeof adminSettingsSaveOutputSchema>;
export type AdminSettingsApplyImmediateInput = z.infer<
  typeof adminSettingsApplyImmediateInputSchema
>;
export type AdminSettingsApplyImmediateOutput = z.infer<
  typeof adminSettingsApplyImmediateOutputSchema
>;
