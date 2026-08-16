import type { PlatformOidcDiscoveryMetadata } from '@lobechat/types';

import { validatePlatformIdentityProviderClaims } from '@/server/enterprise/services/identityProvider/claimValidation';
import { extractIdentityProviderGroups } from '@/server/enterprise/services/identityProvider/groupRoleMapping';
import { stashIdentityProviderGroupRoleMapping } from '@/server/enterprise/services/identityProvider/groupRoleMappingRuntime';
import type { PublishedIdentityProviderPayload } from '@/server/enterprise/services/identityProvider/publicationService';

/**
 * Claim→user projection shared by every provider kind.
 *
 * Kept in its own module so the DingTalk adapter can reuse it without importing the
 * strict-OIDC adapter (which would be a cycle).
 */

export interface RuntimeIdentityProvider extends PublishedIdentityProviderPayload {
  clientSecret: string;
  oidcMetadata: PlatformOidcDiscoveryMetadata;
  revision: number;
}

export interface PlatformIdentityProviderUser {
  dingtalkTitle: string | null;
  dingtalkUserId: string | null;
  email: string;
  id: string;
  image?: string;
  name: string;
}

export const firstStringClaim = (
  profile: Record<string, unknown>,
  candidates: readonly string[],
): string | undefined => {
  for (const candidate of candidates) {
    const value = profile[candidate];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

export const getStableDingTalkClaims = (
  provider: RuntimeIdentityProvider,
  profile: Record<string, unknown>,
) => ({
  dingtalkTitle: firstStringClaim(profile, provider.claimMapping.dingtalkTitle) ?? null,
  dingtalkUserId: firstStringClaim(profile, provider.claimMapping.dingtalkUserId) ?? null,
});

/**
 * Pure claim→user projection. Does NOT stash group-role mappings — that happens
 * exactly once in getUserInfo with the real OAuth flow id. Better Auth also calls
 * mapProfileToUser after getUserInfo; a second stash without flowId used to leave a
 * subject-only entry that a later password login could re-grant.
 */
export const mapPlatformProfileToUser = (
  provider: RuntimeIdentityProvider,
  profile: Record<string, unknown>,
): PlatformIdentityProviderUser => {
  const { issues, values } = validatePlatformIdentityProviderClaims({
    claimMapping: provider.claimMapping,
    claims: profile,
    domainAllowlist: provider.domainAllowlist,
  });
  if (issues.length > 0 || !values.subject || !values.name || !values.email) {
    throw new Error('PLATFORM_OIDC_CLAIM_VALIDATION_FAILED');
  }
  return {
    ...getStableDingTalkClaims(provider, profile),
    email: values.email,
    id: values.subject,
    image: firstStringClaim(profile, provider.claimMapping.picture),
    name: values.name,
  };
};

/** Stash IdP groups once per OAuth flow for session.create role reconciliation. */
export const stashPlatformGroupRoleMapping = (
  provider: RuntimeIdentityProvider,
  profile: Record<string, unknown>,
  subject: string,
  flowId: string | undefined,
): void => {
  if (Object.keys(provider.groupRoleMapping).length === 0) return;
  stashIdentityProviderGroupRoleMapping({
    flowId,
    groupRoleMapping: provider.groupRoleMapping,
    groups: extractIdentityProviderGroups(profile),
    providerKey: provider.providerKey,
    subject,
  });
};
