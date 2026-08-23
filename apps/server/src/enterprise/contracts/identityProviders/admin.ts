import { z } from 'zod';

import {
  identityProviderIssuerSchema,
  identityProviderSecretMutationSchema,
  identityProviderStatusSchema,
  identityProviderTypeSchema,
} from './common';
import {
  editableIdentityProviderDraftSchema,
  identityProviderDraftSchema,
  optionalReasonSchema,
  reasonSchema,
} from './draft';
import { assertFixedProtocolIdentityContract, rejectSecretMaterial } from './refinements';

export const adminIdentityProviderCreateInputSchema = editableIdentityProviderDraftSchema
  .extend({
    reason: optionalReasonSchema,
    secret: identityProviderSecretMutationSchema.refine(
      (value) => value.operation !== 'keep',
      'a new provider cannot keep an existing secret',
    ),
  })
  .superRefine(rejectSecretMaterial)
  .superRefine(assertFixedProtocolIdentityContract);

export const adminIdentityProviderUpdateInputSchema = editableIdentityProviderDraftSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    reason: optionalReasonSchema,
    secret: identityProviderSecretMutationSchema,
  })
  .superRefine(rejectSecretMaterial)
  .superRefine(assertFixedProtocolIdentityContract);

export const adminIdentityProviderGetInputSchema = z
  .object({ id: z.string().min(1).max(128) })
  .strict();
export const adminIdentityProviderGetOutputSchema = identityProviderDraftSchema;

export const adminIdentityProviderListInputSchema = z
  .object({
    cursor: z.string().max(128).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().max(200).optional(),
    status: identityProviderStatusSchema.optional(),
    type: identityProviderTypeSchema.optional(),
  })
  .strict()
  .default({});
export const adminIdentityProviderListOutputSchema = z
  .object({
    items: z.array(identityProviderDraftSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminIdentityProviderDeleteInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    reason: reasonSchema,
  })
  .strict();
export const adminIdentityProviderDeleteOutputSchema = z
  .object({ deleted: z.literal(true) })
  .strict();

/** Reauth-protected disable: publishes a signed tombstone revision (enabled:false). */
export const adminIdentityProviderDisableInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    reason: reasonSchema,
  })
  .strict();
export const adminIdentityProviderDisableOutputSchema = identityProviderDraftSchema;

export const adminIdentityProviderDiscoverInputSchema = z
  .object({
    issuer: identityProviderIssuerSchema,
    /**
     * Provider kind under configuration. Kinds that publish no discovery document
     * (DingTalk) answer from static metadata instead of a `.well-known` fetch.
     * Absent = strict OIDC, preserving the original behaviour for existing callers.
     */
    type: identityProviderTypeSchema.optional(),
  })
  .strict();
export const adminIdentityProviderDiscoveryOutputSchema = z
  .object({
    authorizationEndpoint: z.string().url(),
    // RFC 9207 support flag surfaced by the discovery validator; part of the metadata the
    // runtime carries, so the strict discovery response must accept it (absence caused the
    // "发现并校验网络" 500 / output-validation failure).
    authorizationResponseIssParameterSupported: z.boolean(),
    codeChallengeMethodsSupported: z.array(z.string()),
    idTokenSigningAlgValuesSupported: z.array(z.string()),
    issuer: z.string().url(),
    jwksUri: z.string().url(),
    responseTypesSupported: z.array(z.string()),
    scopesSupported: z.array(z.string()),
    subjectTypesSupported: z.array(z.string()),
    tokenEndpoint: z.string().url(),
    tokenEndpointAuthMethodsSupported: z.array(z.string()),
    userinfoEndpoint: z.string().url().nullable(),
  })
  .strict();
export const adminIdentityProviderValidateNetworkOutputSchema = z
  .object({ valid: z.literal(true) })
  .strict();

export const adminIdentityProviderCallbackUrlsOutputSchema = z
  .object({
    /** DingTalk redirect URL (shim that rewrites `authCode` → `code`). */
    dingtalkProduction: z.string().url(),
    production: z.string().url(),
    test: z.string().url(),
  })
  .strict();

export const adminIdentityProviderRevisionHistoryOutputSchema = z.array(
  z
    .object({
      publishedAt: z.date(),
      revision: z.number().int().positive(),
    })
    .strict(),
);

export const adminIdentityProviderMutationOutputSchema = identityProviderDraftSchema;

export const adminIdentityProviderPublishInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    reason: reasonSchema,
    requestId: z.string().uuid(),
  })
  .strict();
export const adminIdentityProviderPublishOutputSchema = identityProviderDraftSchema;

export const adminIdentityProviderRollbackInputSchema = adminIdentityProviderPublishInputSchema
  .extend({ targetRevision: z.number().int().positive() })
  .strict();
export const adminIdentityProviderRollbackOutputSchema = identityProviderDraftSchema;

export type AdminIdentityProviderCreateInput = z.infer<
  typeof adminIdentityProviderCreateInputSchema
>;
export type AdminIdentityProviderUpdateInput = z.infer<
  typeof adminIdentityProviderUpdateInputSchema
>;
export type AdminIdentityProviderListInput = z.infer<typeof adminIdentityProviderListInputSchema>;
