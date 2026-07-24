import { z } from 'zod';

import { EMAIL_DOMAIN_PATTERN } from '@/types/platform/authSettings';

/**
 * Platform auth-settings admin contracts (direct-save with CAS revision).
 *
 * Matches the flat document shape used by the identity router: settings fields
 * plus `revision` on reads and `expectedRevision` on writes. Domain validation
 * mirrors `platformAuthSettingsSchema` (including non-empty allowlist when enabled).
 */

const revisionSchema = z.number().int().nonnegative();

const domainEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(EMAIL_DOMAIN_PATTERN, { message: 'INVALID_EMAIL_DOMAIN' });

const authSettingsFields = {
  emailDomainAllowlist: z.array(domainEntrySchema).max(200),
  emailDomainAllowlistEnabled: z.boolean(),
  openRegistration: z.boolean(),
} as const;

const requireAllowlistWhenEnabled = (
  value: { emailDomainAllowlist: string[]; emailDomainAllowlistEnabled: boolean },
  ctx: z.RefinementCtx,
) => {
  if (value.emailDomainAllowlistEnabled && value.emailDomainAllowlist.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'EMAIL_DOMAIN_ALLOWLIST_REQUIRED',
      path: ['emailDomainAllowlist'],
    });
  }
};

/** Full platform auth-settings document including CAS revision. */
export const adminAuthSettingsGetOutputSchema = z
  .object({
    ...authSettingsFields,
    revision: revisionSchema,
  })
  .strict()
  .superRefine(requireAllowlistWhenEnabled);
export type AdminAuthSettingsGetOutput = z.infer<typeof adminAuthSettingsGetOutputSchema>;

/** Full-document update with optimistic concurrency token. */
export const adminAuthSettingsUpdateInputSchema = z
  .object({
    ...authSettingsFields,
    expectedRevision: revisionSchema,
  })
  .strict()
  .superRefine(requireAllowlistWhenEnabled);
export type AdminAuthSettingsUpdateInput = z.infer<typeof adminAuthSettingsUpdateInputSchema>;

export const adminAuthSettingsUpdateOutputSchema = adminAuthSettingsGetOutputSchema;
export type AdminAuthSettingsUpdateOutput = z.infer<typeof adminAuthSettingsUpdateOutputSchema>;
