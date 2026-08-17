import { z } from 'zod';

import type { InfraSettingsId } from '@/const/platform/infraSettings';

// Value imports must be relative: packages/types vitest does not resolve `@/const/*`.
import {
  INFRA_SETTINGS_ID_MAIL,
  INFRA_SETTINGS_ID_OBJECT_STORAGE,
  INFRA_SETTINGS_IDS,
  INFRA_SETTINGS_LIMITS,
} from '../../../const/src/platform/infraSettings';

export type { InfraSettingsId };

export const infraSettingsIdSchema = z.enum(INFRA_SETTINGS_IDS);

export const infraSecretActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      value: z.string().min(1).max(INFRA_SETTINGS_LIMITS.SECRET_ACCESS_KEY_MAX),
    })
    .strict(),
]);
export type InfraSecretAction = z.infer<typeof infraSecretActionSchema>;

const optionalHttpUrlSchema = z.string().trim().url().max(INFRA_SETTINGS_LIMITS.ENDPOINT_MAX);

// ---------------------------------------------------------------------------
// Persisted (platform_infra_settings.config)
// ---------------------------------------------------------------------------

export const objectStoragePersistedSchema = z
  .object({
    accessKeyId: z.string().trim().max(INFRA_SETTINGS_LIMITS.ACCESS_KEY_ID_MAX).optional(),
    bucket: z.string().trim().max(INFRA_SETTINGS_LIMITS.BUCKET_MAX).optional(),
    enabled: z.boolean(),
    endpoint: z.string().trim().max(INFRA_SETTINGS_LIMITS.ENDPOINT_MAX).optional(),
    forcePathStyle: z.boolean(),
    previewUrlExpireIn: z
      .number()
      .int()
      .min(INFRA_SETTINGS_LIMITS.PREVIEW_URL_EXPIRE_MIN)
      .max(INFRA_SETTINGS_LIMITS.PREVIEW_URL_EXPIRE_MAX)
      .optional(),
    publicDomain: z.string().trim().max(INFRA_SETTINGS_LIMITS.PUBLIC_DOMAIN_MAX).optional(),
    region: z.string().trim().max(INFRA_SETTINGS_LIMITS.REGION_MAX).optional(),
    secretAccessKeyCiphertext: z.string().min(1).optional(),
    setAcl: z.boolean(),
  })
  .strict();
export type ObjectStoragePersisted = z.infer<typeof objectStoragePersistedSchema>;

export const mailSmtpPersistedSchema = z
  .object({
    host: z.string().trim().min(1).max(INFRA_SETTINGS_LIMITS.SMTP_HOST_MAX),
    passCiphertext: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535),
    secure: z.boolean(),
    user: z.string().trim().min(1).max(INFRA_SETTINGS_LIMITS.SMTP_USER_MAX),
  })
  .strict();
export type MailSmtpPersisted = z.infer<typeof mailSmtpPersistedSchema>;

export const mailResendPersistedSchema = z
  .object({
    apiKeyCiphertext: z.string().min(1).optional(),
  })
  .strict();
export type MailResendPersisted = z.infer<typeof mailResendPersistedSchema>;

export const mailPersistedSchema = z
  .object({
    enabled: z.boolean(),
    fromAddress: z.string().trim().max(INFRA_SETTINGS_LIMITS.FROM_ADDRESS_MAX),
    provider: z.enum(['smtp', 'resend']),
    resend: mailResendPersistedSchema.optional(),
    senderName: z.string().trim().max(INFRA_SETTINGS_LIMITS.SENDER_NAME_MAX).optional(),
    smtp: mailSmtpPersistedSchema.optional(),
  })
  .strict();
export type MailPersisted = z.infer<typeof mailPersistedSchema>;

export type InfraSettingsPersistedConfig = MailPersisted | ObjectStoragePersisted;

export const createDefaultObjectStorageConfig = (): ObjectStoragePersisted => ({
  enabled: false,
  forcePathStyle: false,
  setAcl: false,
});

export const createDefaultMailConfig = (): MailPersisted => ({
  enabled: false,
  fromAddress: '',
  provider: 'smtp',
});

export const createDefaultInfraConfig = (id: InfraSettingsId): InfraSettingsPersistedConfig =>
  id === INFRA_SETTINGS_ID_OBJECT_STORAGE
    ? createDefaultObjectStorageConfig()
    : createDefaultMailConfig();

export const normalizeObjectStorageConfig = (raw: unknown): ObjectStoragePersisted => {
  const defaults = createDefaultObjectStorageConfig();
  if (!raw || typeof raw !== 'object') return defaults;
  const parsed = objectStoragePersistedSchema.safeParse({ ...defaults, ...raw });
  return parsed.success ? parsed.data : defaults;
};

export const normalizeMailConfig = (raw: unknown): MailPersisted => {
  const defaults = createDefaultMailConfig();
  if (!raw || typeof raw !== 'object') return defaults;
  const parsed = mailPersistedSchema.safeParse({ ...defaults, ...raw });
  return parsed.success ? parsed.data : defaults;
};

export const normalizeInfraConfig = (
  id: InfraSettingsId,
  raw: unknown,
): InfraSettingsPersistedConfig =>
  id === INFRA_SETTINGS_ID_OBJECT_STORAGE
    ? normalizeObjectStorageConfig(raw)
    : normalizeMailConfig(raw);

// ---------------------------------------------------------------------------
// Admin-facing view (never leaks ciphertext / plaintext secrets)
// ---------------------------------------------------------------------------

export const objectStorageViewSchema = objectStoragePersistedSchema
  .omit({ secretAccessKeyCiphertext: true })
  .extend({ hasSecretAccessKey: z.boolean() })
  .strict();
export type ObjectStorageView = z.infer<typeof objectStorageViewSchema>;

export const mailViewSchema = mailPersistedSchema
  .omit({ resend: true, smtp: true })
  .extend({
    hasResendApiKey: z.boolean(),
    hasSmtpPass: z.boolean(),
    smtp: z
      .object({
        host: z.string(),
        port: z.number().int(),
        secure: z.boolean(),
        user: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MailView = z.infer<typeof mailViewSchema>;

// ---------------------------------------------------------------------------
// Admin-facing update (explicit keep / replace / clear)
// ---------------------------------------------------------------------------

const requireWhenEnabled = (
  enabled: boolean,
  ctx: z.RefinementCtx,
  fields: Array<{ message: string; path: Array<number | string>; present: boolean }>,
) => {
  if (!enabled) return;
  for (const field of fields) {
    if (field.present) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: field.message,
      path: field.path,
    });
  }
};

export const objectStorageUpdateSchema = z
  .object({
    accessKeyId: z.string().trim().min(1).max(INFRA_SETTINGS_LIMITS.ACCESS_KEY_ID_MAX).optional(),
    bucket: z.string().trim().min(1).max(INFRA_SETTINGS_LIMITS.BUCKET_MAX).optional(),
    enabled: z.boolean(),
    endpoint: optionalHttpUrlSchema.optional(),
    forcePathStyle: z.boolean().optional(),
    previewUrlExpireIn: z
      .number()
      .int()
      .min(INFRA_SETTINGS_LIMITS.PREVIEW_URL_EXPIRE_MIN)
      .max(INFRA_SETTINGS_LIMITS.PREVIEW_URL_EXPIRE_MAX)
      .optional(),
    publicDomain: optionalHttpUrlSchema.optional(),
    region: z.string().trim().max(INFRA_SETTINGS_LIMITS.REGION_MAX).optional(),
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
export type ObjectStorageUpdate = z.input<typeof objectStorageUpdateSchema>;

export const mailUpdateSchema = z
  .object({
    enabled: z.boolean(),
    fromAddress: z.string().trim().email().max(INFRA_SETTINGS_LIMITS.FROM_ADDRESS_MAX).optional(),
    provider: z.enum(['smtp', 'resend']).optional(),
    resend: z
      .object({
        apiKey: infraSecretActionSchema.default({ action: 'keep' }),
      })
      .strict()
      .optional(),
    senderName: z.string().trim().max(INFRA_SETTINGS_LIMITS.SENDER_NAME_MAX).optional(),
    smtp: z
      .object({
        host: z.string().trim().min(1).max(INFRA_SETTINGS_LIMITS.SMTP_HOST_MAX).optional(),
        pass: infraSecretActionSchema.default({ action: 'keep' }),
        port: z.number().int().min(1).max(65_535).optional(),
        secure: z.boolean().optional(),
        user: z.string().trim().min(1).max(INFRA_SETTINGS_LIMITS.SMTP_USER_MAX).optional(),
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
export type MailUpdate = z.input<typeof mailUpdateSchema>;

export const INFRA_SETTINGS_OBJECT_STORAGE_ID = INFRA_SETTINGS_ID_OBJECT_STORAGE;
export const INFRA_SETTINGS_MAIL_ID = INFRA_SETTINGS_ID_MAIL;
