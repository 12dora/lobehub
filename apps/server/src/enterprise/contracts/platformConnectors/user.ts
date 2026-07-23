import { z } from 'zod';

import {
  connectorBindingStatusSchema,
  connectorCredentialModeSchema,
  connectorIdSchema,
  connectorKeySchema,
  connectorReturnToSchema,
  connectorScopesSchema,
  httpUrlSchema,
  publicDisplayNameSchema,
  publicTextSchema,
  publishedConnectorToolObjectSchema,
} from './common';

export const connectorBindingSchema = z
  .object({
    connectedAt: z.date().nullable(),
    expiresAt: z.date().nullable(),
    id: connectorIdSchema,
    lastErrorCategory: z.enum(['auth', 'network', 'oauth', 'policy']).nullable(),
    scopes: connectorScopesSchema,
    status: connectorBindingStatusSchema,
    updatedAt: z.date(),
  })
  .strict();

export const managedConnectorToolSchema = publishedConnectorToolObjectSchema
  .omit({
    description: true,
    displayName: true,
    inputSchema: true,
    outputSchema: true,
    platformPolicy: true,
  })
  .extend({
    available: z.boolean(),
    description: publicTextSchema.nullable(),
    displayName: publicDisplayNameSchema,
  })
  .strict();

/** User projection intentionally omits endpoint, transport, OAuth client/config, and secret state. */
export const managedConnectorSchema = z
  .object({
    binding: connectorBindingSchema.nullable(),
    credentialMode: connectorCredentialModeSchema,
    description: publicTextSchema.nullable(),
    displayName: publicDisplayNameSchema,
    id: connectorIdSchema,
    key: connectorKeySchema,
    publishedRevision: z.number().int().positive(),
    tools: z.array(managedConnectorToolSchema).max(1000),
  })
  .strict();

export const userConnectorListManagedInputSchema = z
  .object({
    cursor: connectorKeySchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const userConnectorListManagedOutputSchema = z
  .object({ items: z.array(managedConnectorSchema), nextCursor: connectorKeySchema.nullable() })
  .strict();

export const userConnectorStartAuthorizationInputSchema = z
  .object({ connectorId: connectorIdSchema, returnTo: connectorReturnToSchema.optional() })
  .strict();
export const connectorAuthorizationAttemptIdSchema = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]+$/);
export const userConnectorStartAuthorizationOutputSchema = z
  .object({
    attemptId: connectorAuthorizationAttemptIdSchema,
    authorizationUrl: httpUrlSchema,
    bindingId: connectorIdSchema,
  })
  .strict();

export const userConnectorGetAuthorizationStatusInputSchema = z
  .object({
    attemptId: connectorAuthorizationAttemptIdSchema,
    connectorId: connectorIdSchema,
  })
  .strict();
export const userConnectorGetAuthorizationStatusOutputSchema = z
  .object({
    attemptId: connectorAuthorizationAttemptIdSchema,
    binding: connectorBindingSchema.nullable(),
    status: z.enum(['pending', 'completed', 'failed', 'expired', 'superseded', 'invalid']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'completed' && value.binding?.status !== 'connected') {
      ctx.addIssue({ code: 'custom', message: 'completed attempt requires connected binding' });
    }
    if (value.status !== 'completed' && value.binding !== null) {
      ctx.addIssue({ code: 'custom', message: 'non-completed attempt must omit binding' });
    }
  });

export const userConnectorDisconnectInputSchema = z
  .object({ connectorId: connectorIdSchema })
  .strict();
export const userConnectorDisconnectOutputSchema = z
  .object({ disconnected: z.literal(true) })
  .strict();
