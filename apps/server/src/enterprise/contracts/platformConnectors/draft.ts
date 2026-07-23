import { z } from 'zod';

import {
  adminConnectorOAuthConfigInputSchema,
  adminConnectorOAuthConfigSchema,
  connectorConnectionTestStateSchema,
  connectorCredentialModeSchema,
  connectorIdSchema,
  connectorKeySchema,
  connectorLifecycleStatusSchema,
  connectorOAuthClientSecretMutationSchema,
  connectorSecretStateSchema,
  connectorSharedSecretMutationSchema,
  connectorToolDraftListSchema,
  connectorToolWithoutIdListSchema,
  emptyConnectorSecretStateSchema,
  httpUrlSchema,
  publicDisplayNameSchema,
  publicTextSchema,
  publishedConnectorToolListSchema,
  publishedConnectorToolObjectSchema,
  reasonSchema,
  webConnectorTransportSchema,
} from './common';

export const adminConnectorDraftBaseSchema = z
  .object({
    connectionTest: connectorConnectionTestStateSchema.nullable(),
    description: publicTextSchema.nullable(),
    displayName: publicDisplayNameSchema,
    enabled: z.boolean(),
    endpoint: httpUrlSchema,
    id: connectorIdSchema,
    key: connectorKeySchema,
    revision: z.number().int().nonnegative(),
    sort: z.number().int(),
    status: connectorLifecycleStatusSchema,
    tools: connectorToolDraftListSchema,
    transport: webConnectorTransportSchema,
  })
  .strict();

export const adminConnectorNoneDraftSchema = adminConnectorDraftBaseSchema
  .extend({
    credentialMode: z.literal('none'),
    oauthClientSecret: emptyConnectorSecretStateSchema,
    oauthConfig: z.null(),
    sharedSecret: emptyConnectorSecretStateSchema,
  })
  .strict();
export const adminConnectorSharedDraftSchema = adminConnectorDraftBaseSchema
  .extend({
    credentialMode: z.literal('shared_service_account'),
    oauthClientSecret: emptyConnectorSecretStateSchema,
    oauthConfig: z.null(),
    sharedSecret: connectorSecretStateSchema,
  })
  .strict();
export const adminConnectorOAuthDraftSchema = adminConnectorDraftBaseSchema
  .extend({
    credentialMode: z.literal('per_user_oauth'),
    oauthClientSecret: connectorSecretStateSchema,
    oauthConfig: adminConnectorOAuthConfigSchema,
    sharedSecret: emptyConnectorSecretStateSchema,
  })
  .strict();

export const adminConnectorDraftSchema = z.discriminatedUnion('credentialMode', [
  adminConnectorNoneDraftSchema,
  adminConnectorSharedDraftSchema,
  adminConnectorOAuthDraftSchema,
]);

export const adminConnectorDraftMutationOutputSchema = z
  .object({
    draft: adminConnectorDraftSchema,
    draftToken: z.string().length(64),
  })
  .strict();

export const publishedConnectorFields = {
  publishedAt: z.date(),
  // Read-only projection of the already-computed published revision provenance checksum
  // (identical to what the agent dependency validator compares against). Surfaced so the M10
  // platform-agent admin UI can author an EXACT connector dependency ref without fabrication.
  // Declared inline (connectorSha256Schema is defined later in the module).
  publishedChecksum: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/),
  publishedRevision: z.number().int().positive(),
  tools: publishedConnectorToolListSchema,
};

export const adminPublishedConnectorSchema = z.discriminatedUnion('credentialMode', [
  adminConnectorNoneDraftSchema
    .omit({ connectionTest: true, revision: true, status: true, tools: true })
    .extend(publishedConnectorFields)
    .strict(),
  adminConnectorSharedDraftSchema
    .omit({ connectionTest: true, revision: true, status: true, tools: true })
    .extend(publishedConnectorFields)
    .strict(),
  adminConnectorOAuthDraftSchema
    .omit({ connectionTest: true, revision: true, status: true, tools: true })
    .extend(publishedConnectorFields)
    .strict(),
]);

export const adminConnectorListItemSchema = z.discriminatedUnion('credentialMode', [
  adminConnectorNoneDraftSchema.omit({ tools: true }),
  adminConnectorSharedDraftSchema.omit({ tools: true }),
  adminConnectorOAuthDraftSchema.omit({ tools: true }),
]);

export const connectorDraftFieldsSchema = z
  .object({
    credentialMode: connectorCredentialModeSchema.optional(),
    description: publicTextSchema.nullable().optional(),
    displayName: publicDisplayNameSchema.optional(),
    enabled: z.boolean().optional(),
    endpoint: httpUrlSchema.optional(),
    oauthClientSecret: connectorOAuthClientSecretMutationSchema.optional(),
    oauthConfig: adminConnectorOAuthConfigInputSchema.nullable().optional(),
    sharedSecret: connectorSharedSecretMutationSchema.optional(),
    sort: z.number().int().optional(),
    tools: connectorToolDraftListSchema.optional(),
    transport: webConnectorTransportSchema.optional(),
  })
  .strict();

export const connectorCreateBaseSchema = z
  .object({
    description: publicTextSchema.nullable().optional(),
    displayName: publicDisplayNameSchema,
    enabled: z.boolean().optional(),
    endpoint: httpUrlSchema,
    key: connectorKeySchema,
    reason: reasonSchema,
    sort: z.number().int().optional(),
    tools: connectorToolWithoutIdListSchema.optional(),
    transport: webConnectorTransportSchema.default('http'),
  })
  .strict();

export const adminConnectorCreateDraftInputSchema = z.discriminatedUnion('credentialMode', [
  connectorCreateBaseSchema.extend({ credentialMode: z.literal('none') }).strict(),
  connectorCreateBaseSchema
    .extend({
      credentialMode: z.literal('shared_service_account'),
      sharedSecret: connectorSharedSecretMutationSchema.optional(),
    })
    .strict(),
  connectorCreateBaseSchema
    .extend({
      credentialMode: z.literal('per_user_oauth'),
      oauthClientSecret: connectorOAuthClientSecretMutationSchema.optional(),
      oauthConfig: adminConnectorOAuthConfigInputSchema,
    })
    .strict(),
]);

export const adminConnectorUpdateDraftInputSchema = connectorDraftFieldsSchema
  .extend({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: connectorIdSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminConnectorDeleteDraftInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: connectorIdSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminConnectorDeleteDraftOutputSchema = z
  .object({ auditId: connectorIdSchema })
  .strict();

export const adminConnectorListInputSchema = z
  .object({
    credentialMode: connectorCredentialModeSchema.optional(),
    cursor: connectorKeySchema.optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().min(1).max(200).optional(),
    status: connectorLifecycleStatusSchema.optional(),
  })
  .strict();

export const adminConnectorListOutputSchema = z
  .object({
    items: z.array(adminConnectorListItemSchema),
    nextCursor: connectorKeySchema.nullable(),
  })
  .strict();

export const adminConnectorGetInputSchema = z.object({ id: connectorIdSchema }).strict();
export const adminConnectorGetOutputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    draft: adminConnectorDraftSchema,
    draftToken: z.string().length(64),
    published: adminPublishedConnectorSchema.nullable(),
  })
  .strict();

/**
 * Bounded bulk draft+published detail for admin tool-scope matrix (≤50 ids, one RPC).
 * Missing / failed ids are listed in `failedIds` instead of aborting the batch.
 */
export const adminConnectorGetBatchInputSchema = z
  .object({ ids: z.array(connectorIdSchema).min(1).max(50) })
  .strict();

export const adminConnectorGetBatchOutputSchema = z
  .object({
    failedIds: z.array(connectorIdSchema),
    items: z.array(adminConnectorGetOutputSchema),
  })
  .strict();

export type AdminConnectorGetBatchInput = z.input<typeof adminConnectorGetBatchInputSchema>;
export type AdminConnectorGetBatchOutput = z.output<typeof adminConnectorGetBatchOutputSchema>;

// Compact exact published projection for BATCH validation of agent connector dependency refs.
// Read-only, bounded (≤100 ids), one query. Carries only what an exact ref needs — never secrets.
export const publishedConnectorBatchToolSchema = publishedConnectorToolObjectSchema
  .pick({ platformPolicy: true, toolKey: true })
  .strict();

export const publishedConnectorBatchItemSchema = z
  .object({
    connectorId: connectorIdSchema,
    connectorKey: connectorKeySchema,
    publishedChecksum: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    publishedRevision: z.number().int().positive(),
    tools: z.array(publishedConnectorBatchToolSchema).max(1000),
  })
  .strict();

export const adminConnectorGetPublishedBatchInputSchema = z
  .object({ ids: z.array(connectorIdSchema).min(1).max(100) })
  .strict();

export const adminConnectorGetPublishedBatchOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          connectorId: connectorIdSchema,
          published: publishedConnectorBatchItemSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type AdminConnectorGetPublishedBatchInput = z.input<
  typeof adminConnectorGetPublishedBatchInputSchema
>;
export type AdminConnectorGetPublishedBatchOutput = z.output<
  typeof adminConnectorGetPublishedBatchOutputSchema
>;
