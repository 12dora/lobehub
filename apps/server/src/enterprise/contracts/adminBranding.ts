import { z } from 'zod';

import {
  platformBrandingAssetUrlSchema,
  platformBrandingLinkUrlSchema,
  platformBrandingNameSchema,
} from '@/types/platform/branding';

const nullableText = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();

const controlledAssetUrlSchema = platformBrandingAssetUrlSchema.refine(
  (value) => /^\/f\/[\w-]{1,128}$/.test(value),
  'Branding assets must use a controlled upload URL',
);

const nullableAssetUrlSchema = controlledAssetUrlSchema.nullable();
const nullableLinkUrlSchema = platformBrandingLinkUrlSchema.nullable();

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
    productName: nullableText(120),
  })
  .strict();

export const adminBrandingDraftSchema = z
  .object({
    defaultAgentDisplayName: nullableText(120),
    desktop: adminBrandingDesktopSchema,
    emailFrom: z.string().trim().email().max(254).nullable(),
    emailSenderName: nullableText(120),
    faviconUrl: nullableAssetUrlSchema,
    homeUrl: nullableLinkUrlSchema,
    iconUrl: nullableAssetUrlSchema,
    legalName: nullableText(200),
    logoUrl: nullableAssetUrlSchema,
    name: platformBrandingNameSchema.nullable(),
    ogImageUrl: nullableAssetUrlSchema,
    pageTitleTemplate: nullableText(200),
    privacyUrl: nullableLinkUrlSchema,
    shortName: nullableText(64),
    supportUrl: nullableLinkUrlSchema,
    termsUrl: nullableLinkUrlSchema,
    themeDefaults: adminBrandingThemeDefaultsSchema,
  })
  .strict();

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
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/x-icon']),
    orphanPolicy: z.literal('retained_until_sweep'),
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
