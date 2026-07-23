import {
  PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS,
  type PlatformIdentityProviderClaimMapping,
  type PlatformIdentityProviderClaimPreview,
  type PlatformIdentityProviderClaimValidationIssue,
} from '@lobechat/types';
import { z } from 'zod';

const firstStringClaim = (
  claims: Record<string, unknown>,
  candidates: readonly string[],
): string | undefined => {
  for (const candidate of candidates) {
    const value = claims[candidate];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 4096);
  }
  return undefined;
};

/** Email syntax + optional domain allowlist. Empty allowlist permits any valid email. */
export const isPlatformIdentityEmailAllowed = (
  email: string,
  allowlist: readonly string[],
): boolean => {
  if (!z.string().email().safeParse(email).success) return false;
  if (allowlist.length === 0) return true;
  const separator = email.lastIndexOf('@');
  if (separator <= 0) return false;
  const domain = email.slice(separator + 1).toLowerCase();
  return allowlist.some((allowed) => {
    const normalized = allowed.trim().toLowerCase().replace(/^@/, '');
    return domain === normalized || domain.endsWith(`.${normalized}`);
  });
};

export interface ValidatedPlatformIdentityClaims {
  email: string;
  name: string;
  subject: string;
}

/**
 * Production-aligned identity claim checks shared by safe-login tests and runtime login.
 * Name resolution mirrors production: claimMapping.name, then preferred_username.
 */
export const validatePlatformIdentityProviderClaims = (input: {
  claimMapping: PlatformIdentityProviderClaimMapping;
  claims: Record<string, unknown>;
  domainAllowlist: readonly string[];
}): {
  issues: PlatformIdentityProviderClaimValidationIssue[];
  values: Partial<ValidatedPlatformIdentityClaims>;
} => {
  const subject = firstStringClaim(input.claims, input.claimMapping.subject);
  const name = firstStringClaim(input.claims, [...input.claimMapping.name, 'preferred_username']);
  const email = firstStringClaim(input.claims, input.claimMapping.email);
  const issues: PlatformIdentityProviderClaimValidationIssue[] = [];

  if (!subject) issues.push({ code: 'required_claim_missing', field: 'subject' });
  if (!name) issues.push({ code: 'required_claim_missing', field: 'name' });
  if (!email) {
    issues.push({ code: 'required_claim_missing', field: 'email' });
  } else if (!z.string().email().safeParse(email).success) {
    issues.push({ code: 'email_invalid', field: 'email' });
  } else if (!isPlatformIdentityEmailAllowed(email, input.domainAllowlist)) {
    issues.push({ code: 'email_domain_denied', field: 'email' });
  }

  return {
    issues,
    values: {
      ...(subject ? { subject } : {}),
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
    },
  };
};

/** Safe-login claim preview: same validity rules as production login. */
export const buildIdentityProviderClaimPreview = (
  claims: Record<string, unknown>,
  mapping: PlatformIdentityProviderClaimMapping,
  domainAllowlist: readonly string[] = [],
): PlatformIdentityProviderClaimPreview => {
  const previewClaims: PlatformIdentityProviderClaimPreview['claims'] = {};
  for (const key of PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim()) previewClaims[key] = value.trim().slice(0, 4096);
  }
  const { issues } = validatePlatformIdentityProviderClaims({
    claimMapping: mapping,
    claims,
    domainAllowlist,
  });
  return { claims: previewClaims, issues, valid: issues.length === 0 };
};
