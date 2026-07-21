import { AiModelTypeSchema } from 'model-bank';
import { z } from 'zod';

import {
  containsSensitiveMaterial,
  isCredentialBearingUrl,
  isSensitiveKey,
  M07_REDACTION_OPTIONS,
} from '../security/redaction';

const providerKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const modelKeySchema = z.string().trim().min(1).max(150);
const validateNonSecretJson = (
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<number | string> = [],
): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNonSecretJson(item, ctx, [...path, index]));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      if (containsSensitiveMaterial(value)) {
        ctx.addIssue({ code: 'custom', message: 'secret material is not allowed', path });
      }
      if (isCredentialBearingUrl(value)) {
        ctx.addIssue({ code: 'custom', message: 'credential-bearing URL is not allowed', path });
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key) && !M07_REDACTION_OPTIONS.isBenignKey(key)) {
      ctx.addIssue({
        code: 'custom',
        message: 'sensitive key is not allowed',
        path: [...path, key],
      });
      continue;
    }
    validateNonSecretJson(child, ctx, [...path, key]);
  }
};

const boundedJsonObjectSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => validateNonSecretJson(value, ctx));

export const aiConnectionTestStateSchema = z
  .object({
    errorCategory: z
      .enum(['auth', 'network', 'rate_limit', 'provider', 'invalid_config'])
      .nullable(),
    latencyMs: z.number().int().nonnegative().nullable(),
    sanitizedMessage: z.string().max(500),
    stale: z.boolean(),
    status: z.enum(['pending', 'success', 'failure']),
    testedAt: z.date(),
    testedDraftToken: z.string().length(64),
    testedRevision: z.number().int().nonnegative(),
  })
  .strict();

const aiStructuredCredentialSchema = z
  .object({
    accessKeyId: z.string().min(1).max(32_768).optional(),
    apiKey: z.string().min(1).max(32_768).optional(),
    apiVersion: z.string().min(1).max(200).optional(),
    authType: z.enum(['none', 'basic', 'bearer', 'custom']).optional(),
    baseURL: z.string().min(1).max(4000).optional(),
    baseURLOrAccountID: z.string().min(1).max(4000).optional(),
    bearerToken: z.string().min(1).max(32_768).optional(),
    bearerTokenExpiresAt: z.string().min(1).max(200).optional(),
    customHeaders: z.record(z.string(), z.string()).optional(),
    oauthAccessToken: z.string().min(1).max(32_768).optional(),
    password: z.string().min(1).max(32_768).optional(),
    region: z.string().min(1).max(200).optional(),
    secretAccessKey: z.string().min(1).max(32_768).optional(),
    sessionToken: z.string().min(1).max(32_768).optional(),
    username: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'credential object must not be empty');

export const aiSecretMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z
    .object({
      operation: z.literal('replace'),
      value: z.union([z.string().min(1).max(32_768), aiStructuredCredentialSchema]),
    })
    .strict(),
  z.object({ operation: z.literal('clear') }).strict(),
]);

export const aiSecretStateSchema = z
  .object({
    configured: z.boolean(),
    fingerprint: z.string().min(1).nullable(),
    updatedAt: z.date().nullable(),
  })
  .strict();

export const aiModelDraftSchema = z
  .object({
    abilities: boundedJsonObjectSchema,
    config: boundedJsonObjectSchema.nullable(),
    contextWindowTokens: z.number().int().positive().nullable(),
    description: z.string().nullable(),
    displayName: z.string().max(200).nullable(),
    enabled: z.boolean(),
    id: z.string().min(1),
    modelKey: modelKeySchema,
    parameters: boundedJsonObjectSchema,
    pricing: boundedJsonObjectSchema.nullable(),
    providerId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    settings: boundedJsonObjectSchema,
    sort: z.number().int(),
    status: z.enum(['draft', 'published', 'archived']),
    type: AiModelTypeSchema,
  })
  .strict();

export const aiProviderDraftSchema = z
  .object({
    checkModel: z.string().nullable(),
    connectionTest: aiConnectionTestStateSchema.nullable().default(null),
    config: boundedJsonObjectSchema,
    description: z.string().nullable(),
    displayName: z.string().min(1),
    enabled: z.boolean(),
    fetchOnClient: z.boolean(),
    id: z.string().min(1),
    logo: z.string().nullable(),
    models: z.array(aiModelDraftSchema),
    providerKey: providerKeySchema,
    revision: z.number().int().nonnegative(),
    secret: aiSecretStateSchema,
    settings: boundedJsonObjectSchema,
    sort: z.number().int(),
    source: z.string().min(1).max(32),
    status: z.enum(['draft', 'published', 'archived']),
  })
  .strict();

export const publishedAiModelSchema = aiModelDraftSchema
  .pick({
    abilities: true,
    contextWindowTokens: true,
    description: true,
    displayName: true,
    modelKey: true,
    parameters: true,
    pricing: true,
    settings: true,
    sort: true,
    type: true,
  })
  .extend({
    config: z.object({ deploymentName: z.string().min(1).max(200).optional() }).strict(),
  })
  .strict();

export const publishedAiProviderSchema = aiProviderDraftSchema
  .pick({
    description: true,
    displayName: true,
    logo: true,
    providerKey: true,
    sort: true,
    source: true,
  })
  .extend({
    models: z.array(publishedAiModelSchema),
    revision: z.number().int().positive(),
  })
  .strict();

export const publishedAiCatalogSchema = z
  .object({
    providers: z.array(publishedAiProviderSchema),
    revision: z.string().min(1),
  })
  .strict();

export const adminAiProviderListInputSchema = z
  .object({
    cursor: providerKeySchema.optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().min(1).max(200).optional(),
    source: z.string().trim().min(1).max(32).optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
  })
  .strict();

export const adminAiProviderListOutputSchema = z
  .object({
    items: z.array(aiProviderDraftSchema.omit({ models: true })),
    nextCursor: providerKeySchema.nullable(),
  })
  .strict();

export const adminAiProviderGetInputSchema = z.object({ id: z.string().min(1) }).strict();

export const adminAiProviderGetOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draft: aiProviderDraftSchema,
    draftToken: z.string().length(64),
    published: publishedAiProviderSchema.nullable(),
  })
  .strict();

const providerDraftFieldsSchema = z
  .object({
    checkModel: z.string().trim().max(150).nullable().optional(),
    config: boundedJsonObjectSchema.optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    fetchOnClient: z.boolean().optional(),
    logo: z.string().trim().max(2000).nullable().optional(),
    secret: aiSecretMutationSchema.optional(),
    settings: boundedJsonObjectSchema.optional(),
    sort: z.number().int().optional(),
  })
  .strict();

export const adminAiProviderCreateDraftInputSchema = providerDraftFieldsSchema
  .extend({
    displayName: z.string().trim().min(1).max(200),
    providerKey: providerKeySchema,
    reason: z.string().trim().min(1).max(2000),
    source: z.string().trim().min(1).max(32).default('custom'),
  })
  .strict();

export const adminAiProviderUpdateDraftInputSchema = providerDraftFieldsSchema
  .extend({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiProviderTestInputSchema = z
  .object({
    id: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const aiConnectionTestResultSchema = z
  .object({
    errorCategory: z
      .enum(['auth', 'network', 'rate_limit', 'provider', 'invalid_config'])
      .nullable(),
    latencyMs: z.number().int().nonnegative(),
    sanitizedMessage: z.string().max(500),
    status: z.enum(['success', 'failure']),
    testedAt: z.date(),
  })
  .strict();

export const adminAiProviderPublishInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiProviderArchiveInputSchema = adminAiProviderPublishInputSchema;

export const adminAiProviderRollbackInputSchema = adminAiProviderPublishInputSchema
  .extend({ targetRevision: z.number().int().positive() })
  .strict();

export const adminAiProviderRevisionOutputSchema = z
  .object({
    auditId: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

export const adminAiProviderRevisionHistoryInputSchema = z
  .object({
    beforeRevision: z.number().int().positive().optional(),
    id: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const adminAiProviderRevisionHistoryOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          checksum: z.string().length(64),
          comment: z.string().nullable(),
          publishedAt: z.date().nullable(),
          publishedBy: z.string().nullable(),
          revision: z.number().int().positive(),
          status: z.enum(['draft', 'published', 'archived', 'rolled_back']),
        })
        .strict(),
    ),
    nextCursor: z.number().int().positive().nullable(),
  })
  .strict();

export const adminAiProviderMutationOutputSchema = aiProviderDraftSchema;

const modelDraftFieldsSchema = z
  .object({
    abilities: boundedJsonObjectSchema.optional(),
    config: boundedJsonObjectSchema.nullable().optional(),
    contextWindowTokens: z.number().int().positive().nullable().optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    displayName: z.string().trim().max(200).nullable().optional(),
    enabled: z.boolean().optional(),
    parameters: boundedJsonObjectSchema.optional(),
    pricing: boundedJsonObjectSchema.nullable().optional(),
    settings: boundedJsonObjectSchema.optional(),
    sort: z.number().int().optional(),
    type: AiModelTypeSchema.optional(),
  })
  .strict();

export const adminAiModelCreateInputSchema = modelDraftFieldsSchema
  .extend({
    expectedDraftToken: z.string().length(64),
    modelKey: modelKeySchema,
    providerId: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiModelUpdateInputSchema = modelDraftFieldsSchema
  .extend({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1),
    providerId: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiModelDeleteInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    id: z.string().min(1),
    providerId: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiModelReorderInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    items: z
      .array(z.object({ id: z.string().min(1), sort: z.number().int() }).strict())
      .min(1)
      .max(500),
    providerId: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiModelDependentsInputSchema = z
  .object({ id: z.string().min(1), providerId: z.string().min(1) })
  .strict();

export const adminAiModelListInputSchema = z
  .object({
    cursor: z.string().min(1).max(1000).optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    provider: providerKeySchema.optional(),
    query: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    type: AiModelTypeSchema.optional(),
  })
  .strict();

export const adminAiModelListItemSchema = aiModelDraftSchema
  .extend({ providerKey: providerKeySchema })
  .strict();

export const adminAiModelListOutputSchema = z
  .object({
    items: z.array(adminAiModelListItemSchema),
    nextCursor: z.string().min(1).max(1000).nullable(),
  })
  .strict();

export const adminAiModelCreateTargetListInputSchema = z
  .object({
    cursor: providerKeySchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const adminAiModelCreateTargetListOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          displayName: z.string().min(1),
          id: z.string().min(1),
          providerKey: providerKeySchema,
        })
        .strict(),
    ),
    nextCursor: providerKeySchema.nullable(),
  })
  .strict();

export const adminAiModelDraftContextInputSchema = z
  .object({ providerId: z.string().min(1) })
  .strict();

export const adminAiModelDraftContextOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draftToken: z.string().length(64),
    modelIds: z.array(z.string().min(1)),
    providerId: z.string().min(1),
  })
  .strict();

export const adminAiModelDependentsOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          blocking: z.boolean(),
          label: z.string().min(1),
          resourceId: z.string().min(1),
          resourceType: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const adminAiModelMutationOutputSchema = aiModelDraftSchema;

export const adminAiModelDeleteOutputSchema = z.object({ deleted: z.literal(true) }).strict();

export const adminAiModelReorderOutputSchema = z
  .object({ draftToken: z.string().length(64), updated: z.number().int().nonnegative() })
  .strict();

/** Draft mutation + immediate publish (admin UI parity; single rate-limit unit). */
export const adminAiProviderApplyImmediateOutputSchema = z
  .object({
    auditId: z.string().min(1).nullable(),
    draft: aiProviderDraftSchema,
    /**
     * false when draft was written but publish validation blocked first publish
     * (e.g. create without models / connection test). Client must not treat as silent success for live catalog.
     */
    published: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const adminAiProviderApplyImmediateInputSchema = z.discriminatedUnion('mode', [
  adminAiProviderCreateDraftInputSchema.extend({ mode: z.literal('create') }),
  adminAiProviderUpdateDraftInputSchema.extend({ mode: z.literal('update') }),
]);

export const adminAiModelApplyImmediateOutputSchema = z
  .object({
    auditId: z.string().min(1),
    draftToken: z.string().length(64),
    revision: z.number().int().positive(),
  })
  .strict();

const modelApplyBase = z.object({
  expectedDraftToken: z.string().length(64),
  providerId: z.string().min(1),
  reason: z.string().trim().min(1).max(2000),
});

export const adminAiModelApplyImmediateInputSchema = z.discriminatedUnion('operation', [
  modelDraftFieldsSchema
    .extend({
      expectedDraftToken: z.string().length(64),
      modelKey: modelKeySchema,
      operation: z.literal('create'),
      providerId: z.string().min(1),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
  modelDraftFieldsSchema
    .extend({
      expectedDraftToken: z.string().length(64),
      expectedRevision: z.number().int().nonnegative(),
      id: z.string().min(1),
      operation: z.literal('update'),
      providerId: z.string().min(1),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
  modelApplyBase
    .extend({
      id: z.string().min(1),
      operation: z.literal('delete'),
    })
    .strict(),
  modelApplyBase
    .extend({
      items: z
        .array(z.object({ id: z.string().min(1), sort: z.number().int() }).strict())
        .min(1)
        .max(500),
      operation: z.literal('reorder'),
    })
    .strict(),
  modelApplyBase
    .extend({
      enabled: z.boolean(),
      modelIds: z.array(z.string().min(1)).min(1).max(500),
      operation: z.literal('batchToggle'),
    })
    .strict(),
  modelApplyBase
    .extend({
      models: z
        .array(
          z
            .object({
              abilities: boundedJsonObjectSchema.optional(),
              config: boundedJsonObjectSchema.nullable().optional(),
              contextWindowTokens: z.number().int().positive().nullable().optional(),
              description: z.string().trim().max(4000).nullable().optional(),
              displayName: z.string().trim().max(200).nullable().optional(),
              enabled: z.boolean().optional(),
              id: z.string().min(1),
              parameters: boundedJsonObjectSchema.optional(),
              pricing: boundedJsonObjectSchema.nullable().optional(),
              settings: boundedJsonObjectSchema.optional(),
              type: AiModelTypeSchema.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(500),
      operation: z.literal('batchUpdate'),
    })
    .strict(),
  modelApplyBase.extend({ operation: z.literal('clear') }).strict(),
]);

export type AiModelDraft = z.infer<typeof aiModelDraftSchema>;
export type AiProviderDraft = z.infer<typeof aiProviderDraftSchema>;
export type PublishedAiCatalog = z.infer<typeof publishedAiCatalogSchema>;
export type PublishedAiProvider = z.infer<typeof publishedAiProviderSchema>;
