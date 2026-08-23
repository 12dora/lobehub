import {
  DINGTALK_CORP_ID_PATTERN,
  DINGTALK_CORP_NAME_MAX_LENGTH,
  PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS,
  PLATFORM_IDENTITY_PROVIDER_TEST_ATTEMPT_STATUSES,
} from '@lobechat/types';
import { z } from 'zod';

import { optionalReasonSchema } from './draft';

export const adminIdentityProviderTestStartInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    reason: optionalReasonSchema,
  })
  .strict();
export const adminIdentityProviderTestStartOutputSchema = z
  .object({ attemptId: z.string().min(1), authorizationUrl: z.string().url(), expiresAt: z.date() })
  .strict();

const previewClaimSummarySchema = z
  .object({ present: z.literal(true), type: z.literal('string') })
  .strict();
export const identityProviderClaimValidationIssueSchema = z
  .object({
    code: z.enum(['email_domain_denied', 'email_invalid', 'required_claim_missing']),
    field: z.enum(['email', 'name', 'subject']),
  })
  .strict();
export const identityProviderClaimPreviewSchema = z
  .object({
    claims: z
      .object(
        Object.fromEntries(
          PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS.map((claim) => [
            claim,
            previewClaimSummarySchema.optional(),
          ]),
        ) as Record<
          (typeof PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS)[number],
          z.ZodOptional<typeof previewClaimSummarySchema>
        >,
      )
      .strict(),
    /**
     * DingTalk capture outcome. Present only for `dingtalk` safe-login tests, where reading the
     * organisation id back is the purpose of the test (the admin never types a corpId).
     */
    dingtalk: z
      .object({
        corpId: z.string().regex(DINGTALK_CORP_ID_PATTERN),
        corpName: z.string().max(DINGTALK_CORP_NAME_MAX_LENGTH).optional(),
        corpNameMissingScope: z.string().max(64).optional(),
        corpNameReason: z
          .enum(['app_token_rejected', 'forbidden', 'name_absent', 'network'])
          .optional(),
        nick: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
    issues: z.array(identityProviderClaimValidationIssueSchema),
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
