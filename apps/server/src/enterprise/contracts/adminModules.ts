import { z } from 'zod';

import {
  PLATFORM_MODULE_IDS,
  PLATFORM_MODULE_PRESETS,
  type PlatformModuleId,
} from '@/const/platform/modules';

const platformModuleIdSchema = z.enum(PLATFORM_MODULE_IDS);

const moduleStateMapSchema = z.object(
  Object.fromEntries(PLATFORM_MODULE_IDS.map((id) => [id, z.boolean()])) as Record<
    PlatformModuleId,
    z.ZodBoolean
  >,
);
const partialModulesSchema = moduleStateMapSchema.partial();

const moduleSettingsSnapshotSchema = z
  .object({
    db: partialModulesSchema.nullable(),
    effective: moduleStateMapSchema,
    envDisabled: z.array(platformModuleIdSchema),
    envDisabledBy: z.record(platformModuleIdSchema, z.string()),
    preset: z.enum(PLATFORM_MODULE_PRESETS).nullable(),
    presetFromEnv: z.enum(PLATFORM_MODULE_PRESETS),
    revision: z.number().int().nonnegative(),
    setupCompletedAt: z.string().nullable(),
  })
  .strict();

const adminModulesViewSchema = z
  .object({
    instanceId: z.string().min(1),
    pendingRestart: z.array(platformModuleIdSchema),
    restart: z
      .object({
        reason: z.string().optional(),
        supported: z.boolean(),
      })
      .strict(),
    snapshot: moduleSettingsSnapshotSchema,
  })
  .strict();

export const adminModulesGetOutputSchema = adminModulesViewSchema;
export type AdminModulesGetOutput = z.infer<typeof adminModulesGetOutputSchema>;

export const adminModulesUpdateInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    modules: partialModulesSchema,
    setupCompleted: z.boolean().optional(),
  })
  .strict();
export type AdminModulesUpdateInput = z.infer<typeof adminModulesUpdateInputSchema>;

export const adminModulesUpdateOutputSchema = adminModulesViewSchema;
export type AdminModulesUpdateOutput = z.infer<typeof adminModulesUpdateOutputSchema>;

export const adminModulesRequestRestartInputSchema = z.object({}).strict();
export type AdminModulesRequestRestartInput = z.infer<typeof adminModulesRequestRestartInputSchema>;

export const adminModulesRequestRestartOutputSchema = z.object({ ok: z.literal(true) }).strict();
export type AdminModulesRequestRestartOutput = z.infer<
  typeof adminModulesRequestRestartOutputSchema
>;
