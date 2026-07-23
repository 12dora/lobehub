import { z } from 'zod';

import {
  connectorIdSchema,
  connectorKeySchema,
  connectorPlatformToolPolicySchema,
  connectorScopesSchema,
  connectorSha256Schema,
  connectorSharedCredentialSchema,
  connectorToolDraftListSchema,
  connectorToolKeySchema,
  httpUrlSchema,
  publishedConnectorToolSchema,
  webConnectorTransportSchema,
} from './common';

export const connectorEffectiveToolPolicyInputSchema = z
  .object({
    agentAllowed: z.boolean(),
    platformPolicy: connectorPlatformToolPolicySchema,
    userEnabled: z.boolean(),
  })
  .strict();

export const connectorEffectiveToolPolicyOutputSchema = z
  .object({ allowed: z.boolean(), deniedBy: z.enum(['platform', 'agent', 'user']).nullable() })
  .strict()
  .superRefine((value, ctx) => {
    if (value.allowed !== (value.deniedBy === null)) {
      ctx.addIssue({ code: 'custom', message: 'allowed and deniedBy must describe one outcome' });
    }
  });

/** Server-owned immutable operation binding. Never accept this from a browser request. */
export const connectorOperationProofSchema = z
  .object({
    connectorId: connectorIdSchema,
    connectorKey: connectorKeySchema,
    operationId: z.string().trim().min(1).max(256),
    publishedChecksum: connectorSha256Schema,
    publishedRevision: z.number().int().positive(),
    toolPolicyFingerprint: connectorSha256Schema,
  })
  .strict();

export const connectorOwnedOperationProofSchema = connectorOperationProofSchema
  .extend({
    agentId: z.string().trim().min(1).max(256),
    agentPolicyFingerprint: connectorSha256Schema,
    managedPolicyRevision: z.number().int().nonnegative(),
    signature: connectorSha256Schema,
    userId: z.string().trim().min(1).max(256),
  })
  .strict();

export const connectorDependencySelectionSchema = z
  .object({
    allowedToolKeys: z.array(connectorToolKeySchema).max(1000),
    connectorId: connectorIdSchema,
    connectorKey: connectorKeySchema,
    publishedChecksum: connectorSha256Schema,
    publishedRevision: z.number().int().positive(),
  })
  .strict();

export const connectorApprovalReceiptSchema = z
  .object({
    agentPolicy: z
      .object({
        revision: z.number().int().nonnegative(),
        selections: z.array(connectorDependencySelectionSchema).max(1000),
      })
      .strict(),
    proof: connectorOwnedOperationProofSchema,
    signature: connectorSha256Schema,
    toolCallFingerprint: connectorSha256Schema,
    toolCallId: z.string().trim().min(1).max(512),
  })
  .strict();

export const connectorRuntimeResolutionBaseSchema = z
  .object({
    connectorId: connectorIdSchema,
    endpoint: httpUrlSchema,
    publishedRevision: z.number().int().positive(),
    tool: publishedConnectorToolSchema,
    transport: webConnectorTransportSchema,
  })
  .strict();

export const connectorRuntimeResolutionSchema = z.discriminatedUnion('credentialMode', [
  connectorRuntimeResolutionBaseSchema.extend({ credentialMode: z.literal('none') }).strict(),
  connectorRuntimeResolutionBaseSchema
    .extend({
      credentialMode: z.literal('shared_service_account'),
      credentials: connectorSharedCredentialSchema,
    })
    .strict(),
  connectorRuntimeResolutionBaseSchema
    .extend({
      accessToken: z.string().min(1).max(32_768),
      bindingId: connectorIdSchema,
      credentialMode: z.literal('per_user_oauth'),
      expiresAt: z.date().nullable(),
      scopes: connectorScopesSchema,
      userId: connectorIdSchema,
    })
    .strict(),
]);

export const trustedPublishedConnectorBaseSchema = z
  .object({
    connectorId: connectorIdSchema,
    endpoint: httpUrlSchema,
    publishedRevision: z.number().int().positive(),
    tools: connectorToolDraftListSchema,
    transport: webConnectorTransportSchema,
  })
  .strict();

/** Server-only trusted catalog projection; never return this schema to a client. */
export const trustedPublishedConnectorSchema = z.discriminatedUnion('credentialMode', [
  trustedPublishedConnectorBaseSchema.extend({ credentialMode: z.literal('none') }).strict(),
  trustedPublishedConnectorBaseSchema
    .extend({
      credentialMode: z.literal('shared_service_account'),
      credentials: connectorSharedCredentialSchema,
    })
    .strict(),
  trustedPublishedConnectorBaseSchema
    .extend({
      allowedScopes: connectorScopesSchema,
      credentialMode: z.literal('per_user_oauth'),
    })
    .strict(),
]);
