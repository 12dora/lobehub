import { z } from 'zod';

import {
  adminConnectorOAuthConfigInputSchema,
  adminConnectorOAuthConfigSchema,
  CONNECTOR_OPERATION_MESSAGE_BY_STATUS,
  connectorIdSchema,
  connectorOAuthClientSecretMutationSchema,
  connectorSafeMessageSchema,
  connectorSharedSecretMutationSchema,
  connectorToolWithoutIdListSchema,
  reasonSchema,
} from './common';
import {
  adminConnectorDraftSchema,
  adminConnectorUpdateDraftInputSchema,
  connectorCreateBaseSchema,
} from './draft';

export const adminConnectorDraftActionInputSchema = z
  .object({ id: connectorIdSchema, reason: reasonSchema })
  .strict();

export const adminConnectorDiscoverInputSchema = adminConnectorDraftActionInputSchema;
export const adminConnectorTestInputSchema = adminConnectorDraftActionInputSchema;

export const adminConnectorDiscoverOutputSchema = z
  .object({
    messageCode: connectorSafeMessageSchema,
    oauthConfig: adminConnectorOAuthConfigSchema.nullable(),
    tools: connectorToolWithoutIdListSchema,
  })
  .strict();

export const adminConnectorTestOutputSchema = z
  .object({
    errorCategory: z.enum(['auth', 'network', 'protocol', 'invalid_config', 'policy']).nullable(),
    latencyMs: z.number().int().nonnegative().nullable(),
    messageCode: connectorSafeMessageSchema,
    status: z.enum(['pending', 'success', 'failure']),
    testedAt: z.date(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.messageCode !== CONNECTOR_OPERATION_MESSAGE_BY_STATUS[value.status]) {
      ctx.addIssue({ code: 'custom', message: 'status and messageCode must match' });
    }
  });

export const adminConnectorPublicationInputSchema = z
  .object({
    expectedDraftToken: z.string().length(64),
    expectedRevision: z.number().int().nonnegative(),
    id: connectorIdSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminConnectorPublishInputSchema = adminConnectorPublicationInputSchema;
export const adminConnectorArchiveInputSchema = adminConnectorPublicationInputSchema;
export const adminConnectorRollbackInputSchema = adminConnectorPublicationInputSchema
  .extend({ targetRevision: z.number().int().positive() })
  .strict();
export const adminConnectorRevokeAllBindingsInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    id: connectorIdSchema,
    reason: reasonSchema,
  })
  .strict();

export const adminConnectorRevokeAllBindingsOutputSchema = z
  .object({
    auditId: connectorIdSchema,
    revoked: z.number().int().nonnegative(),
  })
  .strict();

export const adminConnectorRevisionOutputSchema = z
  .object({ auditId: connectorIdSchema, revision: z.number().int().positive() })
  .strict();

/** Draft mutation + immediate publish (admin UI parity; single rate-limit unit). */
export const adminConnectorApplyImmediateOutputSchema = z
  .object({
    auditId: z.string().min(1).nullable(),
    draft: adminConnectorDraftSchema,
    draftToken: z.string().length(64),
    /**
     * false when draft was written but publish validation blocked first publish
     * (e.g. create without enabled tools / connection not ready). Client must not treat as silent live success.
     */
    published: z.boolean(),
    /** Structured human-safe reason when published is false (never secrets). */
    publishError: z.string().max(500).nullable().optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const adminConnectorPublishNowInputSchema = z
  .object({
    id: connectorIdSchema,
    reason: reasonSchema,
  })
  .strict();

/** Create branches (credentialMode) + update, each tagged with mode for applyImmediate. */
export const adminConnectorApplyImmediateInputSchema = z.union([
  connectorCreateBaseSchema
    .extend({ credentialMode: z.literal('none'), mode: z.literal('create') })
    .strict(),
  connectorCreateBaseSchema
    .extend({
      credentialMode: z.literal('shared_service_account'),
      mode: z.literal('create'),
      sharedSecret: connectorSharedSecretMutationSchema.optional(),
    })
    .strict(),
  connectorCreateBaseSchema
    .extend({
      credentialMode: z.literal('per_user_oauth'),
      mode: z.literal('create'),
      oauthClientSecret: connectorOAuthClientSecretMutationSchema.optional(),
      oauthConfig: adminConnectorOAuthConfigInputSchema,
    })
    .strict(),
  adminConnectorUpdateDraftInputSchema.extend({ mode: z.literal('update') }).strict(),
]);

export type AdminConnectorApplyImmediateInput = z.input<
  typeof adminConnectorApplyImmediateInputSchema
>;
export type AdminConnectorApplyImmediateOutput = z.output<
  typeof adminConnectorApplyImmediateOutputSchema
>;
export type AdminConnectorPublishNowInput = z.input<typeof adminConnectorPublishNowInputSchema>;
