import { IMPERSONATE_CHROME_PROFILE_IDS } from '@lobechat/types';
import { z } from 'zod';

export const adminBrowserProfileSummarySchema = z.object({
  arch: z.enum(['arm', 'x86']),
  chromeVersion: z.string(),
  cores: z.number().int().positive(),
  createdAt: z.date(),
  impersonateProfile: z.enum(IMPERSONATE_CHROME_PROFILE_IDS),
  installationId: z.string().uuid(),
  locale: z.string(),
  memoryGiB: z.number().int().positive(),
  platform: z.enum(['macOS', 'Windows']),
  platformVersion: z.string(),
  revision: z.number().int().nonnegative(),
  screen: z.object({
    dpr: z.number().positive(),
    height: z.number().int().positive(),
    width: z.number().int().positive(),
  }),
  timezone: z.string(),
  updatedAt: z.date(),
});

export const adminBrowserProfileGetOutputSchema = adminBrowserProfileSummarySchema;

export const adminBrowserProfileRegenerateInputSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const adminBrowserProfileRegenerateOutputSchema = adminBrowserProfileSummarySchema;

export type AdminBrowserProfileRegenerateInput = z.infer<
  typeof adminBrowserProfileRegenerateInputSchema
>;
export type AdminBrowserProfileSummary = z.infer<typeof adminBrowserProfileSummarySchema>;
