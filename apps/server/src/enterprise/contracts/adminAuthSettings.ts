import { z } from 'zod';

import {
  platformAuthSettingsFields,
  requireAllowlistWhenEnabled,
} from '@/types/platform/authSettings';

/**
 * Platform auth-settings admin contracts (direct-save with CAS revision).
 *
 * Field shape + allowlist refinement are derived from the shared
 * `platformAuthSettingsFields` / `requireAllowlistWhenEnabled` so domain
 * validation has a single implementation (SCT-04).
 */

const revisionSchema = z.number().int().nonnegative();

/** Full platform auth-settings document including CAS revision. */
export const adminAuthSettingsGetOutputSchema = z
  .object({
    ...platformAuthSettingsFields,
    revision: revisionSchema,
  })
  .strict()
  .superRefine(requireAllowlistWhenEnabled);
export type AdminAuthSettingsGetOutput = z.infer<typeof adminAuthSettingsGetOutputSchema>;

/** Full-document update with optimistic concurrency token. */
export const adminAuthSettingsUpdateInputSchema = z
  .object({
    ...platformAuthSettingsFields,
    expectedRevision: revisionSchema,
  })
  .strict()
  .superRefine(requireAllowlistWhenEnabled);
export type AdminAuthSettingsUpdateInput = z.infer<typeof adminAuthSettingsUpdateInputSchema>;

export const adminAuthSettingsUpdateOutputSchema = adminAuthSettingsGetOutputSchema;
export type AdminAuthSettingsUpdateOutput = z.infer<typeof adminAuthSettingsUpdateOutputSchema>;
