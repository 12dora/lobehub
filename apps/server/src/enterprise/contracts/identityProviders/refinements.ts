import {
  DINGTALK_IDENTITY_PROVIDER_ISSUER,
  isCanonicalDingTalkIdentityContract,
  isDingTalkIdentityProviderIssuer,
  isValidDingTalkProviderKey,
} from '@lobechat/types';
import { z } from 'zod';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import type {
  identityProviderAllowedCorpsSchema,
  identityProviderClaimMappingSchema,
  identityProviderTypeSchema,
} from './common';

/**
 * Kinds whose identity contract is fixed by the protocol are not administrator-configurable.
 *
 * For `dingtalk` the claim mapping selects the Better Auth account id, so an API caller that
 * remapped `subject` to `nick`/`email` could impersonate or collide accounts; the issuer
 * carries the organisation pin, so an arbitrary issuer would silently mean "any organisation".
 * Both are pinned here at the write boundary and again in `parsePublishedIdentityProviderPayload`
 * at the read boundary.
 */
export const assertFixedProtocolIdentityContract = (
  value: {
    claimMapping: z.infer<typeof identityProviderClaimMappingSchema>;
    dingtalkAllowedCorps?: z.infer<typeof identityProviderAllowedCorpsSchema>;
    issuer: string | null;
    providerKey: string;
    scopes: string[];
    type: z.infer<typeof identityProviderTypeSchema>;
  },
  context: z.RefinementCtx,
) => {
  if (value.type !== 'dingtalk') {
    // An organisation grant on a non-DingTalk kind would be dead — and dangerous if the kind
    // were ever switched back — so it is rejected rather than silently ignored.
    if (value.dingtalkAllowedCorps?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'organization allowlist is only valid for the dingtalk provider kind',
        path: ['dingtalkAllowedCorps'],
      });
    }
    return;
  }
  // The provider key becomes the sub-domain of the synthesized address, so it must be a DNS
  // label — otherwise every login would fail email validation at runtime instead of here.
  if (!isValidDingTalkProviderKey(value.providerKey)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'a DingTalk provider key must be a single DNS label (lowercase letters, digits and inner hyphens)',
      path: ['providerKey'],
    });
  }
  // Partial save may omit issuer; when present it must stay the protocol-fixed value.
  if (value.issuer && !isDingTalkIdentityProviderIssuer(value.issuer)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `DingTalk issuer must be exactly ${DINGTALK_IDENTITY_PROVIDER_ISSUER}`,
      path: ['issuer'],
    });
  }
  if (!isCanonicalDingTalkIdentityContract(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'DingTalk claim mapping and scopes are fixed by the protocol and cannot be edited',
      path: ['claimMapping'],
    });
  }
};

export const rejectSecretMaterial = (value: unknown, context: z.RefinementCtx) => {
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
