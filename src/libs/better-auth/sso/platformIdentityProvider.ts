import { createHash, randomBytes } from 'node:crypto';

import type { PlatformOidcDiscoveryMetadata } from '@lobechat/types';
import { getOAuthState } from 'better-auth/api';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import { z } from 'zod';

import { SafeOutboundHttpClient } from '@/server/enterprise/security/outboundHttp';
import { verifyPlatformOidcIdToken } from '@/server/enterprise/services/identityProvider/idTokenVerifier';
import type { PublishedIdentityProviderPayload } from '@/server/enterprise/services/identityProvider/publicationService';
import { exchangePlatformOidcAuthorizationCode } from '@/server/enterprise/services/identityProvider/tokenExchange';

import { mergeReauthAuthorizationParams } from './reauthAuthorizationParams';

const USERINFO_TIMEOUT_MS = 5000;
const USERINFO_MAX_BYTES = 64 * 1024;
const PLATFORM_OIDC_NONCE_HASH_STATE_KEY = 'platformOidcNonceHash';
const PLATFORM_OIDC_PROVIDER_STATE_KEY = 'platformOidcProviderId';
// Better Auth 1.6 requires a tokenUrl before it will create the sign-in URL, even when
// getToken owns the callback exchange. Keep this fixed .invalid sentinel provider-agnostic:
// it satisfies that structural contract and fails closed if Better Auth ever bypasses getToken.
const BETTER_AUTH_UNUSED_TOKEN_ENDPOINT = 'https://platform-oidc-token.invalid/';
const userInfoSchema = z.record(z.string(), z.unknown());

const stripNonceClaim = (claims: Record<string, unknown>): Record<string, unknown> => {
  const sanitized = { ...claims };
  delete sanitized.nonce;
  return sanitized;
};

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
  readOAuthState: typeof getOAuthState = getOAuthState,
): GenericOAuthConfig => {
  if (provider.oidcMetadata.issuer !== provider.issuer) {
    throw new Error('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }
  const redirectURI = `${appUrl}/api/auth/oauth2/callback/${provider.providerKey}`;

  return {
    authorizationUrl: provider.oidcMetadata.authorizationEndpoint,
    authorizationUrlParams: (ctx) => {
      const nonce = randomBytes(32).toString('base64url');
      const additionalData = ctx.body?.additionalData ?? {};
      ctx.body.additionalData = {
        ...additionalData,
        [PLATFORM_OIDC_NONCE_HASH_STATE_KEY]: createHash('sha256').update(nonce).digest('hex'),
        [PLATFORM_OIDC_PROVIDER_STATE_KEY]: provider.providerKey,
      };
      return {
        ...mergeReauthAuthorizationParams({}, additionalData),
        nonce,
      };
    },
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
      const oauthState = await readOAuthState();
      const expectedNonceHash = oauthState?.[PLATFORM_OIDC_NONCE_HASH_STATE_KEY];
      if (
        typeof expectedNonceHash !== 'string' ||
        !/^[\da-f]{64}$/.test(expectedNonceHash) ||
        oauthState?.[PLATFORM_OIDC_PROVIDER_STATE_KEY] !== provider.providerKey
      ) {
        throw new Error('PLATFORM_OIDC_NONCE_INVALID');
      }

      const metadata = provider.oidcMetadata;
      if (!metadata.userinfoEndpoint) {
        throw new Error('PLATFORM_OIDC_USERINFO_REQUIRED');
      }
      const idTokenClaims = await verifyPlatformOidcIdToken({
        clientId: provider.clientId,
        idToken: tokens.idToken,
        metadata,
        nonce: { expectedHash: expectedNonceHash, mode: 'required' },
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

      const profile = {
        ...stripNonceClaim(idTokenClaims),
        ...stripNonceClaim(userInfo),
        emailVerified:
          typeof userInfo.email_verified === 'boolean'
            ? userInfo.email_verified
            : idTokenClaims.email_verified === true,
        id: idTokenClaims.sub,
        sub: idTokenClaims.sub,
      };
      tokens.idToken = undefined;
      return profile;
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
    tokenUrl: BETTER_AUTH_UNUSED_TOKEN_ENDPOINT,
  };
};

export const getStableDingTalkClaims = (
  provider: RuntimeIdentityProvider,
  profile: Record<string, unknown>,
) => ({
  dingtalkTitle: firstStringClaim(profile, provider.claimMapping.dingtalkTitle) ?? null,
  dingtalkUserId: firstStringClaim(profile, provider.claimMapping.dingtalkUserId) ?? null,
});
