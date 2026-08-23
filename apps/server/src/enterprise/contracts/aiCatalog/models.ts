import { AiModelTypeSchema } from 'model-bank';
import { z } from 'zod';

import { boundedJsonObjectSchema } from './boundedJson';
import { aiModelDraftSchema, modelKeySchema, providerKeySchema } from './drafts';

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

/** Model DML + unconditional publish of the parent provider (failures throw). */
export const adminAiModelApplyImmediateOutputSchema = z
  .object({
    auditId: z.string().min(1).nullable(),
    draftToken: z.string().length(64),
    revision: z.number().int().nonnegative(),
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

export type AdminAiModelApplyImmediateInput = z.infer<typeof adminAiModelApplyImmediateInputSchema>;

/** Discover the platform catalog from the shared account's live upstream `models()`. */
export const adminAiModelSyncUpstreamInputSchema = z
  .object({
    // Provider key (`supergrok`), not the platform row UUID — the client store's id.
    providerId: providerKeySchema,
  })
  .strict();

export const adminAiModelSyncUpstreamOutputSchema = z
  .object({
    created: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  })
  .strict();

export type AdminAiModelSyncUpstreamInput = z.infer<typeof adminAiModelSyncUpstreamInputSchema>;
export type AdminAiModelSyncUpstreamOutput = z.infer<typeof adminAiModelSyncUpstreamOutputSchema>;
