import type { GenericOAuthConfig } from 'better-auth/plugins';

import type { PublishedIdentityProviderPayload } from '@/server/enterprise/services/identityProvider/publicationService';

import { createDiscoveryUrl } from './helpers';
import { mergeReauthAuthorizationParams } from './reauthAuthorizationParams';

export interface RuntimeIdentityProvider extends PublishedIdentityProviderPayload {
  clientSecret: string;
  revision: number;
}

const firstStringClaim = (
  profile: Record<string, unknown>,
  candidates: readonly string[],
): string | undefined => {
  for (const candidate of candidates) {
    const value = profile[candidate];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const emailAllowed = (email: string, allowlist: readonly string[]): boolean => {
  if (allowlist.length === 0) return true;
  const separator = email.lastIndexOf('@');
  if (separator <= 0) return false;
  const domain = email.slice(separator + 1).toLowerCase();
  return allowlist.some((allowed) => {
    const normalized = allowed.trim().toLowerCase().replace(/^@/, '');
    return domain === normalized || domain.endsWith(`.${normalized}`);
  });
};

/** The only DB/LKG → Better Auth provider adapter. */
export const buildPlatformIdentityProvider = (
  provider: RuntimeIdentityProvider,
  appUrl: string,
): GenericOAuthConfig => ({
  authorizationUrlParams: (ctx) => mergeReauthAuthorizationParams({}, ctx?.body?.additionalData),
  clientId: provider.clientId,
  clientSecret: provider.clientSecret,
  disableImplicitSignUp: !provider.autoProvision,
  disableSignUp: !provider.autoProvision,
  discoveryUrl: createDiscoveryUrl(provider.issuer),
  issuer: provider.issuer,
  mapProfileToUser: (profile) => {
    const subject = firstStringClaim(profile, provider.claimMapping.subject);
    const name = firstStringClaim(profile, provider.claimMapping.name);
    const email = firstStringClaim(profile, provider.claimMapping.email);
    if (!subject || !name || !email || !emailAllowed(email, provider.domainAllowlist)) {
      throw new Error('PLATFORM_OIDC_CLAIM_VALIDATION_FAILED');
    }
    return {
      email,
      id: subject,
      image: firstStringClaim(profile, provider.claimMapping.picture),
      name,
    };
  },
  pkce: true,
  providerId: provider.providerKey,
  redirectURI: `${appUrl}/api/auth/callback/${provider.providerKey}`,
  requireIssuerValidation: true,
  scopes: provider.scopes,
});

export const getStableDingTalkClaims = (
  provider: RuntimeIdentityProvider,
  profile: Record<string, unknown>,
) => ({
  dingtalkTitle: firstStringClaim(profile, provider.claimMapping.dingtalkTitle) ?? null,
  dingtalkUserId: firstStringClaim(profile, provider.claimMapping.dingtalkUserId) ?? null,
});
