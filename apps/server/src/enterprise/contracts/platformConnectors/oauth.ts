import { z } from 'zod';

import {
  connectorIdSchema,
  connectorReturnToSchema,
  connectorScopesSchema,
  httpUrlSchema,
} from './common';

/** Server-only state. Callback callers submit only `code` and opaque `state`. */
export const connectorOAuthStatePayloadSchema = z
  .object({
    bindingId: connectorIdSchema,
    codeChallengeMethod: z.literal('S256'),
    codeVerifier: z.string().min(43).max(128),
    connectorId: connectorIdSchema,
    expiresAt: z.number().int().positive(),
    issuedAt: z.number().int().positive(),
    publishedRevision: z.number().int().positive(),
    redirectUri: httpUrlSchema,
    returnTo: connectorReturnToSchema.optional(),
    scopes: connectorScopesSchema,
    stateHash: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    stateId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]+$/),
    userId: connectorIdSchema,
  })
  .strict()
  .refine((value) => value.expiresAt > value.issuedAt, 'OAuth state expiry must follow issuance');

export const connectorOAuthCallbackInputSchema = z
  .object({ code: z.string().trim().min(1).max(8192), state: z.string().trim().min(32).max(512) })
  .strict();

/** Strict provider response boundary; unknown/oversized token fields fail closed. */
export const connectorOAuthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(32_768),
    expires_in: z.number().int().nonnegative().max(31_536_000).optional(),
    refresh_token: z.string().min(1).max(32_768).optional(),
    scope: z.string().trim().min(1).max(10_000).optional(),
    token_type: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (value) => value.token_type === undefined || value.token_type.toLowerCase() === 'bearer',
    'unsupported OAuth token type',
  );
