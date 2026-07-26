import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES } from '@/database/schemas/platform';

const MAX_UPLOAD_BASE64_CHARS = Math.ceil(PLATFORM_GLOBAL_CREDENTIAL_MAX_FILE_BYTES / 3) * 4;
export const PLATFORM_GLOBAL_CREDENTIAL_MASK = '••••••••';

export const adminCredsIdInputSchema = z.object({ id: z.number() }).strict();
export const adminCredsKeyInputSchema = z.object({ key: z.string() }).strict();

export const adminCredsCreateFileInputSchema = z
  .object({
    description: z.string().optional(),
    fileHashId: z.string().length(64),
    fileName: z.string().min(1),
    key: z.string().min(1).max(100),
    name: z.string().min(1).max(255),
  })
  .strict();

export const adminCredsCreateKvInputSchema = z
  .object({
    description: z.string().optional(),
    key: z.string().min(1).max(100),
    name: z.string().min(1).max(255),
    type: z.enum(['kv-env', 'kv-header']),
    values: z.record(z.string()),
  })
  .strict();

export const adminCredsCreateOauthInputSchema = z
  .object({
    description: z.string().optional(),
    key: z.string().min(1).max(100),
    name: z.string().min(1).max(255),
    oauthConnectionId: z.number(),
  })
  .strict();

export const adminCredsGetInputSchema = z
  .object({
    decrypt: z.boolean().optional(),
    id: z.number(),
  })
  .strict();

export const adminCredsGetByKeyInputSchema = z
  .object({
    decrypt: z.boolean().optional(),
    key: z.string(),
  })
  .strict();

export const adminCredsSkillStatusInputSchema = z.object({ skillIdentifier: z.string() }).strict();

export const adminCredsUpdateInputSchema = z
  .object({
    description: z.string().optional(),
    expectedRevision: z.number().int().min(0),
    fileHashId: z.string().length(64).optional(),
    fileName: z.string().min(1).optional(),
    id: z.number(),
    name: z.string().optional(),
    values: z.record(z.string()).optional(),
  })
  .strict();

export const adminCredsUploadFileInputSchema = z
  .object({
    file: z
      .string()
      .max(MAX_UPLOAD_BASE64_CHARS)
      .regex(
        /^(?:[A-Z\d+/]{4})*(?:[A-Z\d+/]{2}==|[A-Z\d+/]{3}=)?$/i,
        PLATFORM_ERROR_CODES.PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID,
      ),
    fileName: z.string().min(1),
    fileType: z.string().min(1),
  })
  .strict();

export const adminCredsSummaryOutputSchema = z
  .object({
    createdAt: z.string().min(1),
    description: z.string().optional(),
    fileName: z.string().optional(),
    fileSize: z.number().nonnegative().optional(),
    id: z.number(),
    key: z.string(),
    maskedPreview: z.string().optional(),
    name: z.string(),
    revision: z.number().int().nonnegative(),
    type: z.enum(['file', 'kv-env', 'kv-header']),
    updatedAt: z.string().min(1),
  })
  .strict();

const publicMaskValueSchema = z.enum([
  PLATFORM_GLOBAL_CREDENTIAL_MASK,
  'configured',
  'not_configured',
]);

export const adminCredsGetOutputSchema = adminCredsSummaryOutputSchema
  .extend({
    configured: z.boolean(),
    plaintext: z.record(publicMaskValueSchema).optional(),
  })
  .strict();

export const adminCredsDeleteOutputSchema = z.object({ success: z.boolean() }).strict();
export const adminCredsListOutputSchema = z
  .object({ data: z.array(adminCredsSummaryOutputSchema) })
  .strict();

const credentialTypeSchema = z.enum(['file', 'kv-env', 'kv-header', 'oauth']);
const publicCredentialSummaryOutputSchema = z
  .object({
    createdAt: z.string(),
    description: z.string().optional(),
    fileName: z.string().optional(),
    fileSize: z.number().optional(),
    id: z.number(),
    key: z.string(),
    lastUsedAt: z.string().optional(),
    maskedPreview: z.string().optional(),
    name: z.string(),
    oauthAvatar: z.string().optional(),
    oauthProvider: z.string().optional(),
    oauthUsername: z.string().optional(),
    organizationAccountId: z.number().optional(),
    ownerAccountId: z.number().optional(),
    ownerDisplayName: z.string().optional(),
    ownerNamespace: z.string().optional(),
    ownerType: z.enum(['organization', 'user']).optional(),
    sharedAt: z.string().optional(),
    sharedToActiveWorkspace: z.boolean().optional(),
    type: credentialTypeSchema,
    updatedAt: z.string(),
    visibility: z.enum(['private', 'public']).optional(),
  })
  .strict();

export const adminCredsOauthConnectionsOutputSchema = z
  .object({
    connections: z.array(
      z
        .object({
          avatar: z.string().optional(),
          id: z.number(),
          providerId: z.string(),
          providerName: z.string().optional(),
          username: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const adminCredsSkillStatusOutputSchema = z.array(
  z
    .object({
      boundCred: publicCredentialSummaryOutputSchema.optional(),
      description: z.string().optional(),
      key: z.string(),
      name: z.string(),
      required: z.boolean(),
      satisfied: z.boolean(),
      type: credentialTypeSchema,
    })
    .strict(),
);
export const adminCredsUploadFileOutputSchema = z
  .object({
    fileHashId: z.string().length(64),
    fileName: z.string(),
  })
  .strict();
