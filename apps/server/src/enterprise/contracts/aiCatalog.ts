import { AiModelTypeSchema } from 'model-bank';
import { z } from 'zod';

const providerKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const modelKeySchema = z.string().trim().min(1).max(150);
const boundedJsonObjectSchema = z.record(z.string(), z.unknown());

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

export const aiSecretMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z.object({ operation: z.literal('replace'), value: z.string().min(1).max(32_768) }).strict(),
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

export type AiModelDraft = z.infer<typeof aiModelDraftSchema>;
export type AiProviderDraft = z.infer<typeof aiProviderDraftSchema>;
export type PublishedAiCatalog = z.infer<typeof publishedAiCatalogSchema>;
export type PublishedAiProvider = z.infer<typeof publishedAiProviderSchema>;
