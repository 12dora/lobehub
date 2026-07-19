import {
  PLATFORM_IDENTITY_PROVIDER_STATUSES,
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
    issuer: z.string().url().max(4096),
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
