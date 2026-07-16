/**
 * Strict contracts for `admin.settings.*` (M05).
 */

import { z } from 'zod';

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

export const adminSettingsSaveDraftInputSchema = z
  .object({
    draft: z.record(settingDraftPolicySchema),
    expectedDraftToken: z.string().length(64),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const adminSettingsSaveDraftOutputSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  draftToken: z.string().length(64),
  ok: z.literal(true),
  registryVersion: z.number().int(),
});

export const adminSettingsValidateDraftInputSchema = z
  .object({
    draft: z.record(settingDraftPolicySchema).optional(),
  })
  .strict();

export const adminSettingsValidateDraftOutputSchema = z.object({
  impactEstimate: z.object({
    pathsWithOverrides: z.number().int().nonnegative(),
    totalOverrideRows: z.number().int().nonnegative(),
  }),
  issues: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      path: z.string(),
    }),
  ),
  ok: z.boolean(),
});

export const adminSettingsPublishInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().min(1).max(2000),
    comment: z.string().max(2000).optional(),
  })
  .strict();

export const adminSettingsPublishOutputSchema = z.object({
  auditId: z.string(),
  revision: z.number().int().positive(),
});

export const adminSettingsRollbackInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().min(1).max(2000),
    targetRevision: z.number().int().positive(),
  })
  .strict();

export const adminSettingsRollbackOutputSchema = z.object({
  auditId: z.string(),
  revision: z.number().int().positive(),
});

export type AdminSettingsGetDraftOutput = z.infer<typeof adminSettingsGetDraftOutputSchema>;
export type AdminSettingsSaveDraftInput = z.infer<typeof adminSettingsSaveDraftInputSchema>;
export type AdminSettingsSaveDraftOutput = z.infer<typeof adminSettingsSaveDraftOutputSchema>;
export type AdminSettingsValidateDraftInput = z.infer<typeof adminSettingsValidateDraftInputSchema>;
export type AdminSettingsValidateDraftOutput = z.infer<
  typeof adminSettingsValidateDraftOutputSchema
>;
export type AdminSettingsPublishInput = z.infer<typeof adminSettingsPublishInputSchema>;
export type AdminSettingsPublishOutput = z.infer<typeof adminSettingsPublishOutputSchema>;
export type AdminSettingsRollbackInput = z.infer<typeof adminSettingsRollbackInputSchema>;
export type AdminSettingsRollbackOutput = z.infer<typeof adminSettingsRollbackOutputSchema>;
