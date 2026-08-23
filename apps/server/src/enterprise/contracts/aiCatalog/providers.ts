import { z } from 'zod';

import { boundedJsonObjectSchema } from './boundedJson';
import { aiProviderDraftSchema, providerKeySchema, publishedAiProviderSchema } from './drafts';
import { aiSecretMutationSchema } from './secrets';

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

/**
 * Exactly one of `id` (platform UUID) or `providerKey` (user-facing key).
 * Client admin adapters pass providerKey on nearly every mutation path.
 */
export const adminAiProviderGetInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    providerKey: providerKeySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasId = Boolean(value.id);
    const hasKey = Boolean(value.providerKey);
    if (hasId === hasKey) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one of id or providerKey is required',
        path: hasId ? ['providerKey'] : ['id'],
      });
    }
  });

export const adminAiProviderGetOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draft: aiProviderDraftSchema,
    draftToken: z.string().length(64),
    published: publishedAiProviderSchema.nullable(),
  })
  .strict();

/** Bounded bulk detail read for runtime-state / multi-provider UI (≤100 ids, one RPC). */
export const adminAiProviderGetBatchInputSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(100).optional(),
    providerKeys: z.array(providerKeySchema).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasIds = Boolean(value.ids?.length);
    const hasKeys = Boolean(value.providerKeys?.length);
    if (hasIds === hasKeys) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one of ids or providerKeys is required',
        path: hasIds ? ['providerKeys'] : ['ids'],
      });
    }
  });

export const adminAiProviderGetBatchOutputSchema = z
  .object({
    failedIds: z.array(z.string().min(1)),
    failedProviderKeys: z.array(providerKeySchema),
    items: z.array(adminAiProviderGetOutputSchema),
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
    /**
     * When true, a disable/unpublish that would otherwise fail with
     * PLATFORM_RESOURCE_IN_USE demotes dependent published agents and resets
     * dependent setting paths in the same transaction instead of throwing.
     */
    force: z.boolean().optional(),
    id: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiProviderTestInputSchema = z
  .object({
    id: z.string().min(1),
    /**
     * Probe this model instead of the provider's stored `checkModel`, so an operator can
     * check connectivity against the model picked in the UI without first persisting it.
     * Same grammar as `checkModel`; it must still resolve to an enabled platform chat model.
     */
    model: z.string().trim().min(1).max(150).optional(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiProviderPublishInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    force: z.boolean().optional(),
    id: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiProviderArchiveInputSchema = adminAiProviderPublishInputSchema;

/**
 * Hard-delete a provider (and all its models, secrets, and revisions).
 * Requires expectedRevision + expectedDraftToken so concurrent publishes/draft edits
 * cannot race a stale UI delete. The service locks the provider row first, then the
 * shared dependency-publication lock (same order as publication) before checking references.
 */
export const adminAiProviderDeleteInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const adminAiProviderDeleteOutputSchema = z.object({ deleted: z.literal(true) }).strict();

/** Server-side rollback capability (no admin procedure exposes it). */
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

/**
 * Read-only publication history. Not part of the draft/publish workflow: the agent
 * dependency editor reads the published revision `checksum` from here to pin a
 * model dependency (exact-validated on publish).
 */
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

/**
 * Draft write + unconditional publish (single rate-limit unit).
 * Resolving at all means the change is live: publish failures throw instead of returning
 * a "saved but not published" outcome, so there is no published/publishError pair.
 */
export const adminAiProviderApplyImmediateOutputSchema = z
  .object({
    auditId: z.string().min(1).nullable(),
    draft: aiProviderDraftSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const adminAiProviderApplyImmediateInputSchema = z.discriminatedUnion('mode', [
  adminAiProviderCreateDraftInputSchema.extend({ mode: z.literal('create') }),
  adminAiProviderUpdateDraftInputSchema.extend({ mode: z.literal('update') }),
]);
