import { IMPERSONATE_CHROME_PROFILE_IDS } from '@lobechat/types';
import { z } from 'zod';

const optionIdSchema = z.string().min(1);

export const adminBrowserProfileSummarySchema = z.object({
  arch: z.enum(['arm', 'x86']),
  chromeId: optionIdSchema.nullable(),
  chromeVersion: z.string(),
  computeId: optionIdSchema.nullable(),
  cores: z.number().int().positive(),
  createdAt: z.date(),
  impersonateProfile: z.enum(IMPERSONATE_CHROME_PROFILE_IDS),
  installationId: z.string().uuid(),
  locale: z.string(),
  localeId: optionIdSchema.nullable(),
  memoryGiB: z.number().int().positive(),
  platform: z.enum(['macOS', 'Windows']),
  platformVersion: z.string(),
  revision: z.number().int().nonnegative(),
  screen: z.object({
    dpr: z.number().positive(),
    height: z.number().int().positive(),
    width: z.number().int().positive(),
  }),
  screenId: optionIdSchema.nullable(),
  systemId: optionIdSchema.nullable(),
  timezone: z.string(),
  updatedAt: z.date(),
  webglId: optionIdSchema.nullable(),
});

export const adminBrowserProfileGetOutputSchema = adminBrowserProfileSummarySchema;

export const adminBrowserProfileRegenerateInputSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const adminBrowserProfileRegenerateOutputSchema = adminBrowserProfileSummarySchema;

export const adminBrowserProfileChromeOptionSchema = z.object({
  fullVersion: z.string(),
  id: optionIdSchema,
  impersonateProfile: z.enum(IMPERSONATE_CHROME_PROFILE_IDS),
  label: z.string(),
  major: z.number().int().positive(),
});

export const adminBrowserProfileSystemOptionSchema = z.object({
  arch: z.enum(['arm', 'x86']),
  id: optionIdSchema,
  label: z.string(),
  navigatorPlatform: z.enum(['MacIntel', 'Win32']),
  platform: z.enum(['macOS', 'Windows']),
  platformVersion: z.string(),
});

export const adminBrowserProfileLocaleOptionSchema = z.object({
  acceptLanguage: z.string(),
  id: optionIdSchema,
  label: z.string(),
  timezone: z.string(),
});

export const adminBrowserProfileScreenOptionSchema = z.object({
  dpr: z.number().positive(),
  height: z.number().int().positive(),
  id: optionIdSchema,
  label: z.string(),
  platform: z.enum(['macOS', 'Windows']),
  width: z.number().int().positive(),
});

export const adminBrowserProfileComputeOptionSchema = z.object({
  arch: z.enum(['arm', 'x86']),
  cores: z.number().int().positive(),
  id: optionIdSchema,
  label: z.string(),
  memoryGiB: z.number().int().positive(),
  platform: z.enum(['macOS', 'Windows']),
});

export const adminBrowserProfileWebglOptionSchema = z.object({
  arch: z.enum(['arm', 'x86']),
  id: optionIdSchema,
  label: z.string(),
  platform: z.enum(['macOS', 'Windows']),
  renderer: z.string(),
  vendor: z.string(),
});

export const adminBrowserProfileOptionsSchema = z.object({
  chrome: z.array(adminBrowserProfileChromeOptionSchema),
  compute: z.array(adminBrowserProfileComputeOptionSchema),
  locales: z.array(adminBrowserProfileLocaleOptionSchema),
  screens: z.array(adminBrowserProfileScreenOptionSchema),
  systems: z.array(adminBrowserProfileSystemOptionSchema),
  webgl: z.array(adminBrowserProfileWebglOptionSchema),
});

export const adminBrowserProfileUpdateInputSchema = z.object({
  chromeId: optionIdSchema,
  computeId: optionIdSchema,
  /**
   * The revision the form was built from. Without it the write is last-one-in-wins: the six ids
   * describe the whole fingerprint, so a save composed against a stale screen silently reinstates
   * every dimension the other operator had just changed.
   */
  expectedRevision: z.number().int().nonnegative(),
  localeId: optionIdSchema,
  reason: z.string().trim().max(500).optional(),
  screenId: optionIdSchema,
  systemId: optionIdSchema,
  webglId: optionIdSchema,
});

export const adminBrowserProfileUpdateOutputSchema = adminBrowserProfileSummarySchema;

export type AdminBrowserProfileRegenerateInput = z.infer<
  typeof adminBrowserProfileRegenerateInputSchema
>;
export type AdminBrowserProfileSummary = z.infer<typeof adminBrowserProfileSummarySchema>;
export type AdminBrowserProfileOptions = z.infer<typeof adminBrowserProfileOptionsSchema>;
export type AdminBrowserProfileUpdateInput = z.infer<typeof adminBrowserProfileUpdateInputSchema>;
