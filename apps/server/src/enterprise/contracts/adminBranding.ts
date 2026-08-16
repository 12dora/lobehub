import { z } from 'zod';

import {
  platformBrandingAssetUrlSchema,
  platformBrandingDraftSchema,
  platformBrandingNameSchema,
  platformBrandingPublishedSchema,
} from '@/types/platform/branding';

import { secretSafeAuditReasonSchema } from './shared';

const PLATFORM_BRANDING_ASSET_ID_PATTERN =
  /^pba_[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

export const isPlatformBrandingAssetId = (value: string): boolean =>
  PLATFORM_BRANDING_ASSET_ID_PATTERN.test(value);

export const platformBrandingAssetIdFromUrl = (value: string): string | null => {
  if (!value.startsWith('/f/')) return null;
  const id = value.slice('/f/'.length);
  return isPlatformBrandingAssetId(id) ? id : null;
};

const controlledAssetUrlSchema = platformBrandingAssetUrlSchema.refine(
  (value) => platformBrandingAssetIdFromUrl(value) !== null,
  'Branding assets must use a controlled upload URL',
);

const nullableAssetUrlSchema = controlledAssetUrlSchema.nullable();

export const adminBrandingThemeDefaultsSchema = z
  .object({
    primaryColor: z
      .string()
      .trim()
      .regex(/^#[\dA-F]{6}$/i)
      .nullable(),
  })
  .strict();

export const adminBrandingDesktopSchema = z
  .object({
    iconUrl: nullableAssetUrlSchema,
    productName: platformBrandingNameSchema.nullable(),
  })
  .strict();

export const adminBrandingPayloadSchema = platformBrandingDraftSchema
  .omit({ revision: true })
  .extend({
    desktop: adminBrandingDesktopSchema,
    faviconUrl: nullableAssetUrlSchema,
    iconUrl: nullableAssetUrlSchema,
    logoUrl: nullableAssetUrlSchema,
    ogImageUrl: nullableAssetUrlSchema,
    themeDefaults: adminBrandingThemeDefaultsSchema,
  })
  .strict();

export const projectAdminBrandingPublished = (branding: AdminBrandingPayload, revision: number) =>
  platformBrandingPublishedSchema.parse({
    defaultAgentDisplayName: branding.defaultAgentDisplayName,
    emailFrom: branding.emailFrom,
    emailSenderName: branding.emailSenderName,
    faviconUrl: branding.faviconUrl,
    homeUrl: branding.homeUrl,
    iconUrl: branding.iconUrl,
    legalName: branding.legalName,
    logoUrl: branding.logoUrl,
    name: branding.name,
    ogImageUrl: branding.ogImageUrl,
    pageTitleTemplate: branding.pageTitleTemplate,
    privacyUrl: branding.privacyUrl,
    revision: String(revision),
    shortName: branding.shortName,
    supportUrl: branding.supportUrl,
    termsUrl: branding.termsUrl,
    themeDefaults: branding.themeDefaults,
  });

/** Branding has no draft lane: what the editor loads is what the runtime serves. */
export const adminBrandingGetOutputSchema = z
  .object({
    branding: adminBrandingPayloadSchema,
    revision: z.number().int().nonnegative(),
    storageConfigured: z.boolean(),
    token: z.string().length(64),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
  })
  .strict();

const mutationContextSchema = z
  .object({
    /**
     * Branding edits are ordinary configuration saves — the console no longer prompts for a
     * reason. Still accepted (and audited) when a caller supplies one.
     */
    reason: secretSafeAuditReasonSchema.optional(),
    requestId: z.string().uuid(),
  })
  .strict();

export const adminBrandingSaveInputSchema = mutationContextSchema
  .extend({
    branding: adminBrandingPayloadSchema,
    expectedRevision: z.number().int().nonnegative(),
    expectedToken: z.string().length(64),
  })
  .strict();

export const adminBrandingSaveOutputSchema = adminBrandingGetOutputSchema;

export const adminBrandingAssetKindSchema = z.enum([
  'desktopIcon',
  'favicon',
  'icon',
  'logo',
  'ogImage',
]);

export const adminBrandingUploadAssetInputSchema = z
  .object({
    bytesBase64: z.string().min(4).max(8_000_000),
    fileName: z.string().trim().min(1).max(255),
    kind: adminBrandingAssetKindSchema,
    reason: secretSafeAuditReasonSchema.optional(),
    requestId: z.string().uuid(),
  })
  .strict();

export const adminBrandingUploadAssetOutputSchema = z
  .object({
    height: z.number().int().positive(),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    orphanPolicy: z.literal('bounded_sweep'),
    url: controlledAssetUrlSchema,
    width: z.number().int().positive(),
  })
  .strict();

export type AdminBrandingPayload = z.infer<typeof adminBrandingPayloadSchema>;
export type AdminBrandingGetOutput = z.infer<typeof adminBrandingGetOutputSchema>;
export type AdminBrandingSaveInput = z.infer<typeof adminBrandingSaveInputSchema>;
export type AdminBrandingUploadAssetInput = z.infer<typeof adminBrandingUploadAssetInputSchema>;
