import { z } from 'zod';

/**
 * Redacted EasyAuth status for admin identity / authorization surfaces.
 * Never includes app tokens or raw secret material.
 */
export const adminEasyauthStatusConfigSchema = z
  .object({
    appKey: z.string().min(1).max(64),
    baseUrl: z.string().url().max(4096),
    /** True when EASYAUTH_APP_TOKEN or token file is available — never the token value. */
    tokenConfigured: z.boolean(),
    portalUrl: z.string().url().max(4096).nullable(),
  })
  .strict();

export const adminEasyauthStatusSyncSchema = z
  .object({
    accessGrantedCount: z.number().int().nonnegative(),
    degradedCount: z.number().int().nonnegative(),
    latestFetchedAt: z.date().nullable(),
    totalCount: z.number().int().nonnegative(),
  })
  .strict();

export const adminEasyauthGetStatusOutputSchema = z
  .object({
    config: adminEasyauthStatusConfigSchema,
    sync: adminEasyauthStatusSyncSchema,
  })
  .strict();

export type AdminEasyauthGetStatusOutput = z.infer<typeof adminEasyauthGetStatusOutputSchema>;
