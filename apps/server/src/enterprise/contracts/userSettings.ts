/**
 * Strict contracts for user effective settings / patch / reset (M05).
 */

import { z } from 'zod';

export const userSettingsGetEffectiveOutputSchema = z.object({
  effectiveSettings: z.record(z.unknown()),
  effectiveValues: z.record(z.unknown()),
  pathMeta: z.record(
    z.object({
      canOverride: z.boolean(),
      hidden: z.boolean(),
      locked: z.boolean(),
      mode: z.enum(['user', 'default', 'locked']),
      path: z.string(),
      schemaVersion: z.number().int(),
      source: z.enum(['builtin', 'environment', 'platform', 'user', 'legacy']),
      visibility: z.enum(['visible', 'hidden']),
    }),
  ),
  platformRevision: z.number().int().nonnegative(),
  registryVersion: z.number().int(),
  userOverrideRevision: z.number().int().nonnegative(),
});

export const userSettingsPatchOverrideInputSchema = z.object({
  path: z.string().min(1).max(256),
  value: z.unknown(),
});

export const userSettingsPatchOverrideOutputSchema = z.object({
  path: z.string(),
  revision: z.number().int().nonnegative(),
  value: z.unknown(),
});

export const userSettingsResetOverrideInputSchema = z.object({
  path: z.string().min(1).max(256),
});

export const userSettingsResetOverrideOutputSchema = z.object({
  deleted: z.boolean(),
  path: z.string(),
  revision: z.number().int().nonnegative(),
});

export type UserSettingsGetEffectiveOutput = z.infer<typeof userSettingsGetEffectiveOutputSchema>;
export type UserSettingsPatchOverrideInput = z.infer<typeof userSettingsPatchOverrideInputSchema>;
export type UserSettingsPatchOverrideOutput = z.infer<typeof userSettingsPatchOverrideOutputSchema>;
export type UserSettingsResetOverrideInput = z.infer<typeof userSettingsResetOverrideInputSchema>;
export type UserSettingsResetOverrideOutput = z.infer<typeof userSettingsResetOverrideOutputSchema>;
