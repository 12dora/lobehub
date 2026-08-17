import { AiModelTypeSchema } from 'model-bank';
import { z } from 'zod';

import { boundedJsonObjectSchema } from './aiCatalog/boundedJson';
import { boundedHeaderMapSchema } from './aiCatalog/headers';

export {
  BOUNDED_JSON_MAX_DEPTH,
  BOUNDED_JSON_MAX_KEYS_PER_OBJECT,
  BOUNDED_JSON_MAX_NODES,
  BOUNDED_JSON_MAX_SERIALIZED_BYTES,
} from './aiCatalog/boundedJson';
export {
  BOUNDED_HEADER_MAP_MAX_ENTRIES,
  BOUNDED_HEADER_NAME_MAX,
  BOUNDED_HEADER_VALUE_MAX,
  boundedHeaderMapSchema,
} from './aiCatalog/headers';

const providerKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const modelKeySchema = z.string().trim().min(1).max(150);

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
    customHeaders: boundedHeaderMapSchema.optional(),
    oauthAccessToken: z.string().min(1).max(32_768).optional(),
    /**
     * Display-only identity of a shared OAuth account (OIDC `email`, else
     * `preferred_username`). Not validated as an email — some providers return a username.
     * Deliberately NOT a secret leaf: it is projected to admins by `getConnectionStatus`.
     */
    oauthAccountEmail: z.string().min(1).max(320).optional(),
    oauthAccountId: z.string().min(1).max(200).optional(),
    oauthRefreshToken: z.string().min(1).max(32_768).optional(),
    /** Epoch millis as a string — the platform secret vault only stores string leaves. */
    oauthTokenExpiresAt: z.string().min(1).max(200).optional(),
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
  /**
   * Overlay non-empty credential fields onto the existing vault.
   * Empty strings are ignored and unsubmitted fields are retained, so `unset` is the ONLY
   * way a merge can remove a leaf. Needed when a group of leaves must move as a unit — a
   * shared-OAuth reconnect that returns no email must not leave the previous account's
   * email sitting next to the new credential.
   */
  z
    .object({
      operation: z.literal('merge'),
      unset: z.array(z.string().min(1).max(64)).max(20).optional(),
      value: z.union([z.string().min(1).max(32_768), aiStructuredCredentialSchema]),
    })
    .strict(),
  z.object({ operation: z.literal('clear') }).strict(),
]);

/** Client-facing secret presence only — fingerprint stays server-internal (never projected). */
export const aiSecretStateSchema = z
  .object({
    configured: z.boolean(),
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

/**
 * Stable runtime error codes the connection test may surface. Deliberately an allowlist, not
 * `z.string()`: the probe must never echo provider-authored text (a message can carry request
 * material), and an operator-facing hint may only be keyed off a code we recognise.
 * Values are `AgentRuntimeErrorType` members plus the platform catalog's own code.
 */
export const AI_CONNECTION_TEST_ERROR_TYPES = [
  'AccountDeactivated',
  'AgentRuntimeError',
  // The ChatGPT Web transport binary (curl-impersonate) is not installed on this host.
  'CHATGPT_WEB_TRANSPORT_UNAVAILABLE',
  // The Cursor Agent CLI (`cursor-agent`) is not installed on this host.
  'cli_unavailable',
  'ConnectionCheckFailed',
  'ExceededContextWindow',
  'InsufficientQuota',
  'InvalidBedrockCredentials',
  'InvalidProviderAPIKey',
  'InvalidRequestFormat',
  'InvalidVertexCredentials',
  'ModelNotFound',
  'NoAvailableProvider',
  'OAuthAuthorizationExpired',
  'PermissionDenied',
  'PLATFORM_AI_MODEL_NOT_PUBLISHED',
  'ProviderBizError',
  'ProviderNetworkError',
  'QuotaLimitReached',
  'RateLimitExceeded',
  'UserConfigError',
] as const;

export type AiConnectionTestErrorType = (typeof AI_CONNECTION_TEST_ERROR_TYPES)[number];

export const aiConnectionTestResultSchema = z
  .object({
    errorCategory: z
      .enum(['auth', 'network', 'rate_limit', 'provider', 'invalid_config'])
      .nullable(),
    /** Present only when the runtime reported a code from the allowlist above. */
    errorType: z.enum(AI_CONNECTION_TEST_ERROR_TYPES).optional(),
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

export type AiProviderDraft = z.infer<typeof aiProviderDraftSchema>;
export type PublishedAiCatalog = z.infer<typeof publishedAiCatalogSchema>;
export type PublishedAiProvider = z.infer<typeof publishedAiProviderSchema>;
