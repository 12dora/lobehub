import { z } from 'zod';

import { reasonSchema, requireWhenEnabled } from './common';
import {
  adminSystemDependencyErrorCategorySchema,
  adminSystemDependencyStatusSchema,
} from './status';

export const adminSystemInfraDependencySchema = z.enum(['documentRender', 'mail', 'objectStorage']);

export const adminSystemTestDependencyReasonSchema = z.enum([
  'configured_unverified',
  'configuration_incomplete',
  'not_configured',
  'timeout',
  'unauthorized',
  'unreachable',
]);

const infraSecretActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      value: z.string().min(1).max(512),
    })
    .strict(),
]);

export const adminSystemObjectStorageConfigSchema = z
  .object({
    accessKeyId: z.string().trim().min(1).max(128).optional(),
    bucket: z.string().trim().min(1).max(255).optional(),
    enabled: z.boolean(),
    endpoint: z.string().trim().url().max(2048).optional(),
    forcePathStyle: z.boolean().optional(),
    previewUrlExpireIn: z.number().int().min(60).max(604_800).optional(),
    publicDomain: z.string().trim().url().max(2048).optional(),
    region: z.string().trim().max(64).optional(),
    secretAccessKey: infraSecretActionSchema.default({ action: 'keep' }),
    setAcl: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireWhenEnabled(value.enabled, ctx, [
      {
        message: 'accessKeyId is required when enabled',
        path: ['accessKeyId'],
        present: Boolean(value.accessKeyId),
      },
      {
        message: 'bucket is required when enabled',
        path: ['bucket'],
        present: Boolean(value.bucket),
      },
      {
        message: 'forcePathStyle is required when enabled',
        path: ['forcePathStyle'],
        present: value.forcePathStyle !== undefined,
      },
      {
        message: 'setAcl is required when enabled',
        path: ['setAcl'],
        present: value.setAcl !== undefined,
      },
      {
        message: 'endpoint is required when region is not set',
        path: ['endpoint'],
        present: Boolean(value.endpoint || value.region),
      },
    ]);
  });

export const adminSystemMailConfigSchema = z
  .object({
    enabled: z.boolean(),
    fromAddress: z.string().trim().email().max(320).optional(),
    provider: z.enum(['smtp', 'resend']).optional(),
    resend: z
      .object({ apiKey: infraSecretActionSchema.default({ action: 'keep' }) })
      .strict()
      .optional(),
    senderName: z.string().trim().max(256).optional(),
    smtp: z
      .object({
        host: z.string().trim().min(1).max(255).optional(),
        pass: infraSecretActionSchema.default({ action: 'keep' }),
        port: z.number().int().min(1).max(65_535).optional(),
        secure: z.boolean().optional(),
        user: z.string().trim().min(1).max(320).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireWhenEnabled(value.enabled, ctx, [
      {
        message: 'fromAddress is required when enabled',
        path: ['fromAddress'],
        present: Boolean(value.fromAddress),
      },
      {
        message: 'provider is required when enabled',
        path: ['provider'],
        present: Boolean(value.provider),
      },
      {
        message: 'smtp is required when provider is smtp',
        path: ['smtp'],
        present: value.provider !== 'smtp' || Boolean(value.smtp),
      },
      {
        message: 'smtp.host is required when enabled',
        path: ['smtp', 'host'],
        present: value.provider !== 'smtp' || Boolean(value.smtp?.host),
      },
      {
        message: 'smtp.port is required when enabled',
        path: ['smtp', 'port'],
        present: value.provider !== 'smtp' || value.smtp?.port !== undefined,
      },
      {
        message: 'smtp.secure is required when enabled',
        path: ['smtp', 'secure'],
        present: value.provider !== 'smtp' || value.smtp?.secure !== undefined,
      },
      {
        message: 'smtp.user is required when enabled',
        path: ['smtp', 'user'],
        present: value.provider !== 'smtp' || Boolean(value.smtp?.user),
      },
      {
        message: 'resend is required when provider is resend',
        path: ['resend'],
        present: value.provider !== 'resend' || Boolean(value.resend),
      },
    ]);
  });

export const adminSystemTestDependencyInputSchema = z
  .object({
    dependency: adminSystemInfraDependencySchema,
    draft: z.union([adminSystemObjectStorageConfigSchema, adminSystemMailConfigSchema]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.draft) return;
    const isStorageDraft = 'bucket' in value.draft;
    if (value.dependency === 'objectStorage' && !isStorageDraft) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'draft must be an objectStorage config',
        path: ['draft'],
      });
    }
    if (value.dependency === 'mail' && isStorageDraft) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'draft must be a mail config',
        path: ['draft'],
      });
    }
    if (value.dependency === 'documentRender') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'draft is not supported for documentRender',
        path: ['draft'],
      });
    }
  });

export const adminSystemTestDependencyOutputSchema = z
  .object({
    checkedAt: z.date(),
    latencyMs: z.number().int().nonnegative().max(30_000),
    message: adminSystemTestDependencyReasonSchema.optional(),
    ok: z.boolean(),
  })
  .strict();

export const adminSystemGetInfraSettingsOutputSchema = z
  .object({
    mail: z
      .object({
        enabled: z.boolean(),
        errorCategory: adminSystemDependencyErrorCategorySchema.nullable(),
        fromAddress: z.string().trim().max(320).nullable(),
        hasResendApiKey: z.boolean(),
        hasSmtpPass: z.boolean(),
        host: z.string().trim().max(255).nullable(),
        port: z.number().int().min(1).max(65_535).nullable(),
        provider: z.enum(['resend', 'smtp', 'unconfigured']),
        revision: z.number().int().nonnegative(),
        secure: z.boolean().nullable(),
        senderName: z.string().trim().max(256).nullable(),
        smtpUser: z.string().trim().max(320).nullable(),
        source: z.enum(['db', 'env']),
        status: adminSystemDependencyStatusSchema,
      })
      .strict(),
    objectStorage: z
      .object({
        accessId: z.string().trim().max(128).nullable(),
        bucket: z.string().trim().max(255).nullable(),
        enabled: z.boolean(),
        endpoint: z.string().trim().max(2048).nullable(),
        errorCategory: adminSystemDependencyErrorCategorySchema.nullable(),
        hasSecretAccessKey: z.boolean(),
        pathStyle: z.boolean(),
        previewUrlExpireIn: z.number().int().nullable(),
        publicDomain: z.string().trim().max(2048).nullable(),
        region: z.string().trim().max(64).nullable(),
        revision: z.number().int().nonnegative(),
        setAcl: z.boolean(),
        source: z.enum(['db', 'env']),
        status: adminSystemDependencyStatusSchema,
      })
      .strict(),
    snapshotAt: z.date(),
  })
  .strict();

export const adminSystemUpdateInfraSettingsInputSchema = z.discriminatedUnion('dependency', [
  z
    .object({
      config: adminSystemObjectStorageConfigSchema,
      dependency: z.literal('objectStorage'),
      expectedRevision: z.number().int().nonnegative(),
      reason: reasonSchema.optional(),
    })
    .strict(),
  z
    .object({
      config: adminSystemMailConfigSchema,
      dependency: z.literal('mail'),
      expectedRevision: z.number().int().nonnegative(),
      reason: reasonSchema.optional(),
    })
    .strict(),
]);

export const adminSystemUpdateInfraSettingsOutputSchema = z
  .object({
    appliedAt: z.date(),
    revision: z.number().int().nonnegative(),
    source: z.enum(['db', 'env']),
  })
  .strict();

export type AdminSystemInfraDependency = z.infer<typeof adminSystemInfraDependencySchema>;
export type AdminSystemTestDependencyInput = z.input<typeof adminSystemTestDependencyInputSchema>;
export type AdminSystemTestDependencyReason = z.infer<typeof adminSystemTestDependencyReasonSchema>;
export type AdminSystemGetInfraSettings = z.infer<typeof adminSystemGetInfraSettingsOutputSchema>;
export type AdminSystemGetInfraSettingsOutput = AdminSystemGetInfraSettings;
export type AdminSystemInfraSecretAction = z.infer<typeof infraSecretActionSchema>;
export type AdminSystemObjectStorageConfig = z.infer<typeof adminSystemObjectStorageConfigSchema>;
export type AdminSystemMailConfig = z.infer<typeof adminSystemMailConfigSchema>;
export type AdminSystemUpdateInfraSettingsInput = z.input<
  typeof adminSystemUpdateInfraSettingsInputSchema
>;
export type AdminSystemUpdateInfraSettingsOutput = z.infer<
  typeof adminSystemUpdateInfraSettingsOutputSchema
>;
