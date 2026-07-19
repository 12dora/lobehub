import { z } from 'zod';

import {
  platformBrandingAssetUrlSchema,
  platformBrandingDraftSchema,
  platformBrandingNameSchema,
  platformBrandingPublishedSchema,
} from '@/types/platform/branding';

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

export const adminBrandingDraftSchema = platformBrandingDraftSchema
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

export const projectAdminBrandingPublished = (draft: AdminBrandingDraft, revision: number) =>
  platformBrandingPublishedSchema.parse({
    defaultAgentDisplayName: draft.defaultAgentDisplayName,
    emailFrom: draft.emailFrom,
    emailSenderName: draft.emailSenderName,
    faviconUrl: draft.faviconUrl,
    homeUrl: draft.homeUrl,
    iconUrl: draft.iconUrl,
    legalName: draft.legalName,
    logoUrl: draft.logoUrl,
    name: draft.name,
    ogImageUrl: draft.ogImageUrl,
    pageTitleTemplate: draft.pageTitleTemplate,
    privacyUrl: draft.privacyUrl,
    revision: String(revision),
    shortName: draft.shortName,
    supportUrl: draft.supportUrl,
    termsUrl: draft.termsUrl,
  });

const publishedSnapshotSchema = adminBrandingDraftSchema.extend({
  name: platformBrandingNameSchema,
  revision: z.number().int().positive(),
});

const brandingRevisionSummarySchema = z
  .object({
    createdAt: z.date(),
    createdBy: z.string().nullable(),
    reason: z.string().nullable(),
    revision: z.number().int().positive(),
  })
  .strict();

export const adminBrandingGetDraftOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draft: adminBrandingDraftSchema,
    draftToken: z.string().length(64),
    published: publishedSnapshotSchema.nullable(),
    revisions: z.array(brandingRevisionSummarySchema),
    draftMatchesPublished: z.boolean(),
    storageConfigured: z.boolean(),
  })
  .strict();

const mutationContextSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    requestId: z.string().uuid(),
  })
  .strict();

export const adminBrandingSaveDraftInputSchema = mutationContextSchema
  .extend({
    draft: adminBrandingDraftSchema,
    expectedDraftToken: z.string().length(64),
  })
  .strict();

export const adminBrandingSaveDraftOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draftToken: z.string().length(64),
    ok: z.literal(true),
  })
  .strict();

export const adminBrandingPublishInputSchema = mutationContextSchema
  .extend({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const adminBrandingPublishOutputSchema = z
  .object({
    auditId: z.string(),
    revision: z.number().int().positive(),
  })
  .strict();

export const adminBrandingRollbackInputSchema = mutationContextSchema
  .extend({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().positive(),
  })
  .strict();

export const adminBrandingRollbackOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draft: adminBrandingDraftSchema,
    draftToken: z.string().length(64),
    restoredFromRevision: z.number().int().positive(),
  })
  .strict();

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
    reason: z.string().trim().min(1).max(2000),
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

export type AdminBrandingDraft = z.infer<typeof adminBrandingDraftSchema>;
export type AdminBrandingGetDraftOutput = z.infer<typeof adminBrandingGetDraftOutputSchema>;
export type AdminBrandingPublishInput = z.infer<typeof adminBrandingPublishInputSchema>;
export type AdminBrandingRollbackInput = z.infer<typeof adminBrandingRollbackInputSchema>;
export type AdminBrandingSaveDraftInput = z.infer<typeof adminBrandingSaveDraftInputSchema>;
export type AdminBrandingUploadAssetInput = z.infer<typeof adminBrandingUploadAssetInputSchema>;
