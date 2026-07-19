import {
  PLATFORM_IDENTITY_PROVIDER_STATUSES,
  PLATFORM_IDENTITY_PROVIDER_TEST_ATTEMPT_STATUSES,
  PLATFORM_IDENTITY_PROVIDER_TYPES,
} from '@lobechat/types';
import { z } from 'zod';

import { containsEnterpriseSecretMaterial, isSensitiveKey } from '../security/redaction';

const claimNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[\w.:-]+$/)
  .refine((value) => !isSensitiveKey(value), 'credential claim names are not allowed');

const claimCandidatesSchema = (minimum = 0) =>
  z
    .array(claimNameSchema)
    .min(minimum)
    .max(8)
    .refine((claims) => new Set(claims).size === claims.length, 'claim names must be unique');

export const identityProviderClaimMappingSchema = z
  .object({
    dingtalkTitle: claimCandidatesSchema(),
    dingtalkUserId: claimCandidatesSchema(),
    email: claimCandidatesSchema(),
    name: claimCandidatesSchema(1),
    picture: claimCandidatesSchema(),
    subject: claimCandidatesSchema(1),
  })
  .strict();

const oidcScopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);

export const identityProviderIssuerSchema = z
  .string()
  .min(1)
  .max(4096)
  .url()
  .refine((value) => value === value.trim(), 'issuer cannot contain surrounding whitespace')
  .superRefine((value, context) => {
    const issuer = new URL(value);
    if (
      issuer.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      (issuer.port && issuer.port !== '443')
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'issuer must be canonical HTTPS' });
    }
  });

export const identityProviderScopesSchema = z
  .array(oidcScopeSchema)
  .min(1)
  .max(32)
  .refine((scopes) => scopes.includes('openid'), 'openid scope is required')
  .refine((scopes) => new Set(scopes).size === scopes.length, 'scopes must be unique');

export const identityProviderTypeSchema = z.enum(PLATFORM_IDENTITY_PROVIDER_TYPES);
export const identityProviderStatusSchema = z.enum(PLATFORM_IDENTITY_PROVIDER_STATUSES);

export const identityProviderSecretMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z.object({ operation: z.literal('replace'), value: z.string().min(1).max(32_768) }).strict(),
  z.object({ operation: z.literal('clear') }).strict(),
]);

export const identityProviderSecretStateSchema = z
  .object({
    configured: z.boolean(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    updatedAt: z.date().nullable(),
  })
  .strict();

export const oidcDiscoveryMetadataSchema = z
  .object({
    authorization_endpoint: z.string().url().max(4096),
    code_challenge_methods_supported: z.array(z.string().min(1).max(128)).max(32).default([]),
    id_token_signing_alg_values_supported: z.array(z.string().min(1).max(128)).min(1).max(32),
    issuer: identityProviderIssuerSchema,
    jwks_uri: z.string().url().max(4096),
    response_types_supported: z.array(z.string().min(1).max(128)).min(1).max(32),
    scopes_supported: z.array(oidcScopeSchema).max(64).default([]),
    subject_types_supported: z.array(z.string().min(1).max(128)).min(1).max(16),
    token_endpoint: z.string().url().max(4096),
    token_endpoint_auth_methods_supported: z.array(z.string().min(1).max(128)).max(32).default([]),
    userinfo_endpoint: z.string().url().max(4096).optional(),
  })
  .passthrough();

export const identityProviderDraftSchema = z
  .object({
    activationRevision: z.number().int().positive().nullable(),
    autoProvision: z.boolean(),
    buttonLabel: z.string().trim().min(1).max(200),
    claimMapping: identityProviderClaimMappingSchema,
    clientId: z.string().trim().min(1).max(1000).nullable(),
    displayName: z.string().trim().min(1).max(200),
    domainAllowlist: z.array(z.string().trim().min(1).max(253)).max(256),
    enabled: z.boolean(),
    groupRoleMapping: z.record(z.string().min(1).max(256), z.string().min(1).max(128)),
    icon: z.string().max(4096).nullable(),
    id: z.string().min(1).max(128),
    issuer: z.string().url().max(4096).nullable(),
    providerKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    revision: z.number().int().nonnegative(),
    scopes: identityProviderScopesSchema,
    secret: identityProviderSecretStateSchema,
    status: identityProviderStatusSchema,
    type: identityProviderTypeSchema,
    migrationRequired: z.boolean(),
    usePkce: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    const publicConfig = {
      buttonLabel: value.buttonLabel,
      claimMapping: value.claimMapping,
      clientId: value.clientId,
      displayName: value.displayName,
      domainAllowlist: value.domainAllowlist,
      groupRoleMapping: value.groupRoleMapping,
      icon: value.icon,
      issuer: value.issuer,
      providerKey: value.providerKey,
      scopes: value.scopes,
    };
    if (containsEnterpriseSecretMaterial(publicConfig)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'credential material is not allowed in identity provider drafts',
      });
    }
  });

const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (value) => !containsEnterpriseSecretMaterial(value),
    'credential material is not allowed in audit reasons',
  );

const editableIdentityProviderDraftSchema = z
  .object({
    autoProvision: z.boolean().default(true),
    buttonLabel: z.string().trim().min(1).max(200),
    claimMapping: identityProviderClaimMappingSchema,
    clientId: z.string().trim().min(1).max(1000),
    displayName: z.string().trim().min(1).max(200),
    domainAllowlist: z.array(z.string().trim().min(1).max(253)).max(256).default([]),
    groupRoleMapping: z.record(z.string().min(1).max(256), z.string().min(1).max(128)).default({}),
    icon: z.string().max(4096).nullable().default(null),
    issuer: z.string().url().max(4096),
    providerKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    scopes: identityProviderScopesSchema,
    type: identityProviderTypeSchema,
    usePkce: z.literal(true),
  })
  .strict();

const rejectSecretMaterial = (value: unknown, context: z.RefinementCtx) => {
  const {
    expectedRevision: _expectedRevision,
    id: _id,
    reason: _reason,
    secret: _secret,
    ...publicConfig
  } = value as Record<string, unknown>;
  if (containsEnterpriseSecretMaterial(publicConfig)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'credential material is not allowed in identity provider drafts',
    });
  }
};

export const adminIdentityProviderCreateInputSchema = editableIdentityProviderDraftSchema
  .extend({
    reason: reasonSchema,
    secret: identityProviderSecretMutationSchema.refine(
      (value) => value.operation !== 'keep',
      'a new provider cannot keep an existing secret',
    ),
  })
  .superRefine(rejectSecretMaterial);

export const adminIdentityProviderUpdateInputSchema = editableIdentityProviderDraftSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    reason: reasonSchema,
    secret: identityProviderSecretMutationSchema,
  })
  .superRefine(rejectSecretMaterial);

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

export const adminIdentityProviderDiscoverInputSchema = z
  .object({ issuer: identityProviderIssuerSchema })
  .strict();
export const adminIdentityProviderDiscoveryOutputSchema = z
  .object({
    authorizationEndpoint: z.string().url(),
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
  .object({ production: z.string().url(), test: z.string().url() })
  .strict();

export const adminIdentityProviderTestStartInputSchema = z
  .object({ id: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative() })
  .strict();
export const adminIdentityProviderTestStartOutputSchema = z
  .object({ attemptId: z.string().min(1), authorizationUrl: z.string().url(), expiresAt: z.date() })
  .strict();

const previewClaimValueSchema = z.string().max(4096);
export const identityProviderClaimPreviewSchema = z
  .object({
    claims: z
      .object({
        dingtalk_title: previewClaimValueSchema.optional(),
        dingtalk_user_id: previewClaimValueSchema.optional(),
        email: previewClaimValueSchema.optional(),
        name: previewClaimValueSchema.optional(),
        picture: previewClaimValueSchema.optional(),
        preferred_username: previewClaimValueSchema.optional(),
        sub: previewClaimValueSchema.optional(),
      })
      .strict(),
    issues: z.array(
      z
        .object({ code: z.literal('required_claim_missing'), field: z.enum(['name', 'subject']) })
        .strict(),
    ),
    valid: z.boolean(),
  })
  .strict();
export const adminIdentityProviderTestResultInputSchema = z
  .object({ attemptId: z.string().min(1).max(128) })
  .strict();
export const adminIdentityProviderTestResultOutputSchema = z
  .object({
    attemptId: z.string(),
    errorCode: z.string().nullable(),
    result: identityProviderClaimPreviewSchema.nullable(),
    status: z.enum(PLATFORM_IDENTITY_PROVIDER_TEST_ATTEMPT_STATUSES),
  })
  .strict();

export const adminIdentityProviderMutationOutputSchema = identityProviderDraftSchema;

export type AdminIdentityProviderCreateInput = z.infer<
  typeof adminIdentityProviderCreateInputSchema
>;
export type AdminIdentityProviderUpdateInput = z.infer<
  typeof adminIdentityProviderUpdateInputSchema
>;
export type AdminIdentityProviderListInput = z.infer<typeof adminIdentityProviderListInputSchema>;
