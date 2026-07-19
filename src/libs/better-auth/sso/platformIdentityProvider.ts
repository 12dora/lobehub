import type { PlatformOidcDiscoveryMetadata } from '@lobechat/types';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import { z } from 'zod';

import { SafeOutboundHttpClient } from '@/server/enterprise/security/outboundHttp';
import { verifyPlatformOidcIdToken } from '@/server/enterprise/services/identityProvider/idTokenVerifier';
import type { PublishedIdentityProviderPayload } from '@/server/enterprise/services/identityProvider/publicationService';
import { exchangePlatformOidcAuthorizationCode } from '@/server/enterprise/services/identityProvider/tokenExchange';

import { mergeReauthAuthorizationParams } from './reauthAuthorizationParams';

const USERINFO_TIMEOUT_MS = 5000;
const USERINFO_MAX_BYTES = 64 * 1024;
const userInfoSchema = z.record(z.string(), z.unknown());

export interface RuntimeIdentityProvider extends PublishedIdentityProviderPayload {
  clientSecret: string;
  oidcMetadata: PlatformOidcDiscoveryMetadata;
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

interface PlatformIdentityProviderUser {
  dingtalkTitle: string | null;
  dingtalkUserId: string | null;
  email: string;
  id: string;
  image?: string;
  name: string;
}

/** The only DB/LKG → Better Auth provider adapter. */
export const buildPlatformIdentityProvider = (
  provider: RuntimeIdentityProvider,
  appUrl: string,
  outbound = new SafeOutboundHttpClient({ mode: 'public-only' }),
): GenericOAuthConfig => {
  if (provider.oidcMetadata.issuer !== provider.issuer) {
    throw new Error('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }
  const redirectURI = `${appUrl}/api/auth/oauth2/callback/${provider.providerKey}`;

  return {
    authorizationUrl: provider.oidcMetadata.authorizationEndpoint,
    authorizationUrlParams: (ctx) => mergeReauthAuthorizationParams({}, ctx?.body?.additionalData),
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    disableImplicitSignUp: !provider.autoProvision,
    disableSignUp: !provider.autoProvision,
    getToken: async ({ code, codeVerifier, redirectURI: callbackRedirectURI }) => {
      const token = await exchangePlatformOidcAuthorizationCode({
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        code,
        expectedRedirectUri: redirectURI,
        metadata: provider.oidcMetadata,
        outbound,
        pkceVerifier: codeVerifier,
        redirectUri: callbackRedirectURI,
      });
      if (!token.access_token) throw new Error('PLATFORM_OIDC_TOKEN_RESPONSE_INVALID');
      return {
        accessToken: token.access_token,
        accessTokenExpiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000)
          : undefined,
        expiresIn: token.expires_in,
        idToken: token.id_token,
        raw: token,
        refreshToken: token.refresh_token,
        scopes: token.scope?.split(' ').filter(Boolean) ?? [],
        tokenType: token.token_type ?? 'Bearer',
      };
    },
    getUserInfo: async (tokens) => {
      if (!tokens.idToken || !tokens.accessToken) {
        throw new Error('PLATFORM_OIDC_TOKEN_INVALID');
      }

      const metadata = provider.oidcMetadata;
      if (!metadata.userinfoEndpoint) {
        throw new Error('PLATFORM_OIDC_USERINFO_REQUIRED');
      }
      const idTokenClaims = await verifyPlatformOidcIdToken({
        clientId: provider.clientId,
        idToken: tokens.idToken,
        metadata,
        nonce: { mode: 'not_requested' },
        outbound,
      });
      const response = await outbound.fetch(metadata.userinfoEndpoint, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
        },
        maxRedirects: 0,
        maxResponseBytes: USERINFO_MAX_BYTES,
        method: 'GET',
        secretBearing: true,
        timeoutMs: USERINFO_TIMEOUT_MS,
      });
      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        !response.ok ||
        response.truncated ||
        (contentType !== 'application/json' && !contentType?.endsWith('+json'))
      ) {
        throw new Error('PLATFORM_OIDC_USERINFO_INVALID');
      }
      const userInfo = userInfoSchema.parse(await response.json());
      const userInfoSubject = firstStringClaim(userInfo, ['sub']);
      if (userInfoSubject !== idTokenClaims.sub) {
        throw new Error('PLATFORM_OIDC_USERINFO_SUBJECT_MISMATCH');
      }

      return {
        ...idTokenClaims,
        ...userInfo,
        emailVerified:
          typeof userInfo.email_verified === 'boolean'
            ? userInfo.email_verified
            : idTokenClaims.email_verified === true,
        id: idTokenClaims.sub,
        sub: idTokenClaims.sub,
      };
    },
    issuer: provider.issuer,
    mapProfileToUser: (profile) => {
      const subject = firstStringClaim(profile, provider.claimMapping.subject);
      const name = firstStringClaim(profile, [...provider.claimMapping.name, 'preferred_username']);
      const email = firstStringClaim(profile, provider.claimMapping.email);
      if (!subject || !name || !email || !emailAllowed(email, provider.domainAllowlist)) {
        throw new Error('PLATFORM_OIDC_CLAIM_VALIDATION_FAILED');
      }
      return {
        ...getStableDingTalkClaims(provider, profile),
        email,
        id: subject,
        image: firstStringClaim(profile, provider.claimMapping.picture),
        name,
      } satisfies PlatformIdentityProviderUser;
    },
    pkce: true,
    providerId: provider.providerKey,
    redirectURI,
    requireIssuerValidation: true,
    scopes: provider.scopes,
  };
};

export const getStableDingTalkClaims = (
  provider: RuntimeIdentityProvider,
  profile: Record<string, unknown>,
) => ({
  dingtalkTitle: firstStringClaim(profile, provider.claimMapping.dingtalkTitle) ?? null,
  dingtalkUserId: firstStringClaim(profile, provider.claimMapping.dingtalkUserId) ?? null,
});
