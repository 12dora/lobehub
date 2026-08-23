import { z } from 'zod';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import {
  identityProviderAllowedCorpsSchema,
  identityProviderClaimMappingSchema,
  identityProviderIssuerSchema,
  identityProviderScopesSchema,
  identityProviderSecretStateSchema,
  identityProviderStatusSchema,
  identityProviderTypeSchema,
  oidcScopeSchema,
} from './common';

export const oidcDiscoveryMetadataSchema = z
  .object({
    authorization_endpoint: z.string().url().max(4096),
    authorization_response_iss_parameter_supported: z.boolean().optional(),
    code_challenge_methods_supported: z.array(z.string().min(1).max(128)).max(32).default([]),
    id_token_signing_alg_values_supported: z.array(z.string().min(1).max(128)).min(1).max(32),
    issuer: identityProviderIssuerSchema,
    jwks_uri: z.string().url().max(4096),
    response_types_supported: z.array(z.string().min(1).max(128)).min(1).max(32),
    scopes_supported: z.array(oidcScopeSchema).max(64).default([]),
    subject_types_supported: z.array(z.string().min(1).max(128)).min(1).max(16),
    token_endpoint: z.string().url().max(4096),
    token_endpoint_auth_methods_supported: z.array(z.string().min(1).max(128)).max(32).optional(),
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
    dingtalkAllowedCorps: identityProviderAllowedCorpsSchema,
    displayName: z.string().trim().min(1).max(200),
    domainAllowlist: z.array(z.string().trim().min(1).max(253)).max(256),
    enabled: z.boolean(),
    groupRoleMapping: z.record(z.string().min(1).max(256), z.string().min(1).max(128)),
    /** Present on list/get when the server batched lifecycle metadata. */
    hasPublishedHistory: z.boolean().optional(),
    icon: z.string().max(4096).nullable(),
    id: z.string().min(1).max(128),
    issuer: z.string().url().max(4096).nullable(),
    providerKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    /** Present on list/get when the server resolved current-revision test readiness. */
    publishTestReady: z.boolean().optional(),
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

export const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (value) => !containsEnterpriseSecretMaterial(value),
    'credential material is not allowed in audit reasons',
  );

/**
 * Reason is collected only where the platform treats the action as dangerous (publish, disable,
 * rollback, delete — all reauth-gated). Routine draft work (save, safe-login test, DingTalk
 * organisation capture) is fully reconstructable from the audit before/after diffs and the
 * revision history, so demanding free text there bought no forensic value and cost every
 * administrator an extra modal.
 */
export const optionalReasonSchema = reasonSchema.optional();

/** Recorded in the audit trail when an operation does not collect a reason. */
export const NO_REASON_AUDIT_PLACEHOLDER = '—';

/**
 * Partial-save writable fields. `issuer` / `clientId` may be omitted so a wizard can persist
 * the first step before discovery/client are filled. Completeness is enforced on publish
 * (`publicationService`), not here.
 */
const optionalIdentityProviderClientIdSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : (value ?? null)),
  z.string().trim().min(1).max(1000).nullable(),
);

const optionalIdentityProviderIssuerSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  identityProviderIssuerSchema.nullable(),
);

export const editableIdentityProviderDraftSchema = z
  .object({
    autoProvision: z.boolean().default(true),
    buttonLabel: z.string().trim().min(1).max(200),
    claimMapping: identityProviderClaimMappingSchema,
    clientId: optionalIdentityProviderClientIdSchema,
    dingtalkAllowedCorps: identityProviderAllowedCorpsSchema.default([]),
    displayName: z.string().trim().min(1).max(200),
    domainAllowlist: z.array(z.string().trim().min(1).max(253)).max(256).default([]),
    groupRoleMapping: z.record(z.string().min(1).max(256), z.string().min(1).max(128)).default({}),
    icon: z.string().max(4096).nullable().default(null),
    issuer: optionalIdentityProviderIssuerSchema,
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
