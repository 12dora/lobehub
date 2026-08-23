import {
  DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH,
  DINGTALK_ALLOWED_CORPS_MAX,
  DINGTALK_CORP_ID_PATTERN,
  DINGTALK_CORP_NAME_MAX_LENGTH,
  PLATFORM_IDENTITY_PROVIDER_STATUSES,
  PLATFORM_IDENTITY_PROVIDER_TYPES,
} from '@lobechat/types';
import { z } from 'zod';

import { isSensitiveKey } from '../../security/redaction';

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

export const oidcScopeSchema = z
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

/**
 * DingTalk organisation allowlist. Values are captured by the wizard's DingTalk login flow, so
 * the charset stays permissive (DingTalk ids are opaque) while length/count are strict.
 */
export const identityProviderAllowedCorpsSchema = z
  .array(
    z
      .object({
        addedAt: z.string().datetime({ offset: true }),
        addedBy: z.string().min(1).max(128).optional(),
        corpId: z.string().regex(DINGTALK_CORP_ID_PATTERN),
        corpName: z.string().trim().min(1).max(DINGTALK_CORP_NAME_MAX_LENGTH).optional(),
        label: z.string().trim().max(DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH).optional(),
      })
      .strict(),
  )
  .max(DINGTALK_ALLOWED_CORPS_MAX)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.corpId)).size === entries.length,
    'organization ids must be unique',
  );

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
    updatedAt: z.date().nullable(),
  })
  .strict();
