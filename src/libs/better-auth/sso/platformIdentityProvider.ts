import { randomBytes } from 'node:crypto';

import type { EnterpriseOidcFailureCategory } from '@lobechat/observability-otel/modules/enterprise-platform';
import type { PlatformOidcDiscoveryMetadata } from '@lobechat/types';
import { getOAuthState } from 'better-auth/api';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import { z } from 'zod';

import type { LobeChatDatabase } from '@/database/type';
import {
  SafeOutboundHttpClient,
  SafeOutboundHttpError,
} from '@/server/enterprise/security/outboundHttp';
import { validatePlatformIdentityProviderClaims } from '@/server/enterprise/services/identityProvider/claimValidation';
import { extractIdentityProviderGroups } from '@/server/enterprise/services/identityProvider/groupRoleMapping';
import {
  reconcileIdentityProviderGroupRoles,
  stashIdentityProviderGroupRoleMapping,
} from '@/server/enterprise/services/identityProvider/groupRoleMappingRuntime';
import { verifyPlatformOidcIdToken } from '@/server/enterprise/services/identityProvider/idTokenVerifier';
import type { PublishedIdentityProviderPayload } from '@/server/enterprise/services/identityProvider/publicationService';
import { exchangePlatformOidcAuthorizationCode } from '@/server/enterprise/services/identityProvider/tokenExchange';

import {
  markPlatformOidcLoginStage,
  observePlatformOidcLoginFailure,
  suppressPlatformOidcLoginObservation,
} from './platformIdentityProviderObservation';
import {
  createPlatformOidcNonceBinding,
  PLATFORM_OIDC_NONCE_HASH_STATE_KEY,
  PLATFORM_OIDC_PROVIDER_STATE_KEY,
} from './platformIdentityProviderState';
import { mergeReauthAuthorizationParams } from './reauthAuthorizationParams';

const USERINFO_TIMEOUT_MS = 5000;
const USERINFO_MAX_BYTES = 64 * 1024;
// Better Auth 1.6 requires a tokenUrl before it will create the sign-in URL, even when
// getToken owns the callback exchange. Keep this fixed .invalid sentinel provider-agnostic:
// it satisfies that structural contract and fails closed if Better Auth ever bypasses getToken.
const BETTER_AUTH_UNUSED_TOKEN_ENDPOINT = 'https://platform-oidc-token.invalid/';
const userInfoSchema = z.record(z.string(), z.unknown());

const isNetworkError = (error: unknown): boolean => {
  const visited = new Set<Error>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof SafeOutboundHttpError) return true;
    if (current.name === 'AbortError' || current.name === 'TimeoutError') return true;
    const code = Object.getOwnPropertyDescriptor(current, 'code')?.value;
    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT'
    ) {
      return true;
    }
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value;
  }
  return false;
};

const tokenFailureCategory = (error: unknown): EnterpriseOidcFailureCategory =>
  isNetworkError(error) ? 'network_failure' : 'token_invalid';

const idTokenFailureCategory = (error: unknown): EnterpriseOidcFailureCategory => {
  if (error instanceof Error && error.message === 'PLATFORM_OIDC_NONCE_INVALID') {
    return 'nonce_invalid';
  }
  return isNetworkError(error) ? 'network_failure' : 'id_token_invalid';
};

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

interface PlatformIdentityProviderUser {
  dingtalkTitle: string | null;
  dingtalkUserId: string | null;
  email: string;
  id: string;
  image?: string;
  name: string;
}

const mapPlatformProfileToUser = (
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
  // Stash IdP groups for account/session after-hook role reconciliation.
  // getUserInfo knows groups but not userId; session/account create has userId.
  if (Object.keys(provider.groupRoleMapping).length > 0) {
    stashIdentityProviderGroupRoleMapping({
      groupRoleMapping: provider.groupRoleMapping,
      groups: extractIdentityProviderGroups(profile),
      providerKey: provider.providerKey,
      subject: values.subject,
    });
  }
  return {
    ...getStableDingTalkClaims(provider, profile),
    email: values.email,
    id: values.subject,
    image: firstStringClaim(profile, provider.claimMapping.picture),
    name: values.name,
  };
};

/**
 * Enforce stashed IdP group→platform role mapping at login time.
 * Call from Better Auth session.create.before (pre-session boundary) once userId is known.
 * Fail-closed: reconcileIdentityProviderGroupRoles propagates apply failures so the
 * session hook can abort creation (return false) rather than issue an elevated session.
 */
export const enforcePlatformOidcGroupRoleMappingOnLogin = async (input: {
  /** Better Auth account.accountId = IdP subject */
  accountId: string;
  db: LobeChatDatabase;
  /** Better Auth account.providerId = platform providerKey */
  providerId: string;
  userId: string;
}): Promise<void> => {
  if (!input.userId || !input.providerId || !input.accountId) return;
  await reconcileIdentityProviderGroupRoles({
    db: input.db,
    providerKey: input.providerId,
    subject: input.accountId,
    userId: input.userId,
  });
};

/**
 * Session-create path: try every linked account so a returning OIDC login
 * (account update may not fire) still applies the pending group mapping.
 */
export const enforcePlatformOidcGroupRoleMappingForUserAccounts = async (input: {
  accounts: ReadonlyArray<{ accountId: string; providerId: string }>;
  db: LobeChatDatabase;
  userId: string;
}): Promise<void> => {
  if (!input.userId || input.accounts.length === 0) return;
  for (const linked of input.accounts) {
    await enforcePlatformOidcGroupRoleMappingOnLogin({
      accountId: linked.accountId,
      db: input.db,
      providerId: linked.providerId,
      userId: input.userId,
    });
  }
};

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
      if (ctx.path === '/sign-in/oauth2') {
        ctx.body.additionalData = {
          ...additionalData,
          ...createPlatformOidcNonceBinding(nonce, provider.providerKey),
        };
      }
      return {
        ...mergeReauthAuthorizationParams({}, additionalData),
        nonce,
      };
    },
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    disableImplicitSignUp: !provider.autoProvision,
    disableSignUp: !provider.autoProvision,
    // Enterprise directory is authoritative: refresh name/avatar/dingtalk fields each login.
    overrideUserInfo: true,
    getToken: async ({ code, codeVerifier, redirectURI: callbackRedirectURI }) => {
      let isAccountLink = false;
      try {
        isAccountLink = (await readOAuthState())?.link !== undefined;
      } catch {
        // Direct adapter calls have no Better Auth request state; observability stays best-effort.
      }
      if (isAccountLink) await suppressPlatformOidcLoginObservation();
      else await markPlatformOidcLoginStage('token_exchange');
      try {
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
      } catch (error) {
        await markPlatformOidcLoginStage('token_exchange', tokenFailureCategory(error));
        await observePlatformOidcLoginFailure();
        throw error;
      }
    },
    getUserInfo: async (tokens) => {
      if (!tokens.idToken || !tokens.accessToken) {
        await markPlatformOidcLoginStage('token_exchange', 'token_invalid');
        await observePlatformOidcLoginFailure();
        throw new Error('PLATFORM_OIDC_TOKEN_INVALID');
      }
      const oauthState = await readOAuthState();
      if (oauthState?.link !== undefined) await suppressPlatformOidcLoginObservation();
      const expectedNonceHash = oauthState?.[PLATFORM_OIDC_NONCE_HASH_STATE_KEY];
      if (
        typeof expectedNonceHash !== 'string' ||
        !/^[\da-f]{64}$/.test(expectedNonceHash) ||
        oauthState?.[PLATFORM_OIDC_PROVIDER_STATE_KEY] !== provider.providerKey
      ) {
        await markPlatformOidcLoginStage('state_validation', 'state_invalid');
        await observePlatformOidcLoginFailure();
        throw new Error('PLATFORM_OIDC_NONCE_INVALID');
      }

      const metadata = provider.oidcMetadata;
      if (!metadata.userinfoEndpoint) {
        await markPlatformOidcLoginStage('userinfo', 'userinfo_invalid');
        await observePlatformOidcLoginFailure();
        throw new Error('PLATFORM_OIDC_USERINFO_REQUIRED');
      }
      await markPlatformOidcLoginStage('id_token_verification');
      let idTokenClaims: Awaited<ReturnType<typeof verifyPlatformOidcIdToken>>;
      try {
        idTokenClaims = await verifyPlatformOidcIdToken({
          clientId: provider.clientId,
          idToken: tokens.idToken,
          metadata,
          nonce: { expectedHash: expectedNonceHash, mode: 'required' },
          outbound,
        });
      } catch (error) {
        await markPlatformOidcLoginStage('id_token_verification', idTokenFailureCategory(error));
        await observePlatformOidcLoginFailure();
        throw error;
      }
      await markPlatformOidcLoginStage('userinfo');
      let response: Awaited<ReturnType<SafeOutboundHttpClient['fetch']>>;
      try {
        response = await outbound.fetch(metadata.userinfoEndpoint, {
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
      } catch (error) {
        await markPlatformOidcLoginStage('userinfo', 'network_failure');
        await observePlatformOidcLoginFailure();
        throw error;
      }
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
        await markPlatformOidcLoginStage('userinfo', 'userinfo_invalid');
        await observePlatformOidcLoginFailure();
        throw new Error('PLATFORM_OIDC_USERINFO_INVALID');
      }
      let userInfo: z.infer<typeof userInfoSchema>;
      try {
        userInfo = userInfoSchema.parse(await response.json());
      } catch (error) {
        await markPlatformOidcLoginStage('userinfo', 'userinfo_invalid');
        await observePlatformOidcLoginFailure();
        throw error;
      }
      const userInfoSubject = firstStringClaim(userInfo, ['sub']);
      if (userInfoSubject !== idTokenClaims.sub) {
        await markPlatformOidcLoginStage('userinfo', 'subject_mismatch');
        await observePlatformOidcLoginFailure();
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
      await markPlatformOidcLoginStage('authenticated');
      try {
        mapPlatformProfileToUser(provider, profile);
      } catch (error) {
        await markPlatformOidcLoginStage('authenticated', 'claim_invalid');
        await observePlatformOidcLoginFailure();
        throw error;
      }
      tokens.idToken = undefined;
      return profile;
    },
    issuer: provider.issuer,
    mapProfileToUser: (profile) => mapPlatformProfileToUser(provider, profile),
    pkce: true,
    providerId: provider.providerKey,
    redirectURI,
    // Authentik (this deploy) does not support RFC 9207: auth responses omit `iss` and
    // discovery has no authorization_response_iss_parameter_supported. better-auth still
    // rejects a present-but-mismatched iss; when missing we must not fail closed here.
    // Issuer authenticity is enforced by getUserInfo → verifyPlatformOidcIdToken (iss/sig/aud/nonce).
    requireIssuerValidation: false,
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
