import { randomBytes } from 'node:crypto';

import { buildDingTalkLoginCallbackUrl } from '@lobechat/types';
import { getOAuthState } from 'better-auth/api';
import type { GenericOAuthConfig } from 'better-auth/plugins';

import type { SafeOutboundHttpClient } from '@/server/enterprise/security/outboundHttp';
import {
  assertDingTalkCorpAllowed,
  assertDingTalkIssuer,
  DINGTALK_TOKEN_ENDPOINT,
  type DingTalkClaims,
  exchangeDingTalkAuthorizationCode,
  fetchDingTalkUserProfile,
  toDingTalkClaims,
} from '@/server/enterprise/services/identityProvider/kinds';

import {
  markPlatformOidcLoginStage,
  observePlatformOidcLoginFailure,
  suppressPlatformOidcLoginObservation,
} from './platformIdentityProviderObservation';
import {
  mapPlatformProfileToUser,
  type RuntimeIdentityProvider,
  stashPlatformGroupRoleMapping,
} from './platformIdentityProviderProfile';
import {
  createPlatformOidcNonceBinding,
  PLATFORM_OIDC_NONCE_HASH_STATE_KEY,
  PLATFORM_OIDC_PROVIDER_STATE_KEY,
} from './platformIdentityProviderState';

/**
 * DingTalk (钉钉) → Better Auth `genericOAuth` adapter for the DB-driven login-method system.
 *
 * This is the only place where the four strict-OIDC invariants are relaxed, and only for
 * `type === 'dingtalk'`:
 *  1. no boot-time discovery — endpoints come from the static kind metadata;
 *  2. JSON-body token exchange that returns no `id_token`;
 *  3. profile read authenticated with `x-acs-dingtalk-access-token` instead of Bearer;
 *  4. email is synthesized when DingTalk exposes none.
 *
 * What is NOT relaxed: the OAuth `state` binding (provider identity + nonce hash) is still
 * created and verified, group→role mapping is still stashed per flow, the login observability
 * stages are still marked, and claim validation / domain allowlist still run unchanged.
 */
/**
 * Defense in depth over the configured claim mapping. The published-payload parser already
 * pins the DingTalk mapping to `subject: ['unionId']`, but the Better Auth account id must
 * never be anything other than the DingTalk unionId — a mutable field such as `nick` or
 * `email` would let one DingTalk user take over another's account.
 */
const mapDingTalkProfileToUser = (
  provider: RuntimeIdentityProvider,
  claims: Record<string, unknown>,
) => {
  const mapped = mapPlatformProfileToUser(provider, claims);
  const unionId = typeof claims.unionId === 'string' ? claims.unionId.trim() : '';
  if (!unionId || mapped.id !== unionId) throw new Error('PLATFORM_DINGTALK_SUBJECT_INVALID');
  return mapped;
};

export const buildPlatformDingTalkProvider = (
  provider: RuntimeIdentityProvider,
  appUrl: string,
  outbound: SafeOutboundHttpClient,
  readOAuthState: typeof getOAuthState = getOAuthState,
): GenericOAuthConfig => {
  /**
   * Two different callback URLs, and they are NOT interchangeable:
   *
   * - `redirectURI` (below) is what Better Auth puts in DingTalk's authorization request and what
   *   the administrator registers in the DingTalk console. It must be the shim, because DingTalk
   *   answers with `authCode` and Better Auth's own callback only reads `code`.
   * - `betterAuthCallbackURI` is Better Auth's internal callback, which the shim 302s to. Better
   *   Auth always passes THIS value to `getToken` (`${baseURL}/oauth2/callback/${providerId}`,
   *   never the configured `redirectURI`), so it is what the assertion below must compare against.
   */
  const betterAuthCallbackURI = `${appUrl}/api/auth/oauth2/callback/${provider.providerKey}`;
  const dingtalkRedirectURI = buildDingTalkLoginCallbackUrl(appUrl, provider.providerKey);
  // Throws on a non-canonical issuer: a DingTalk provider whose stored identity does not match
  // the protocol must not be materialized at all.
  assertDingTalkIssuer(provider.issuer);
  const allowedCorps = provider.dingtalkAllowedCorps;

  return {
    authorizationUrl: provider.oidcMetadata.authorizationEndpoint,
    authorizationUrlParams: (ctx) => {
      // DingTalk ignores `nonce`, but the shared state plugin requires it on the authorization
      // URL before it will publish the provider binding (and the /oauth2/link flow fails closed
      // without it). Keep emitting it so state handling stays identical across kinds.
      const nonce = randomBytes(32).toString('base64url');
      const additionalData = ctx.body?.additionalData ?? {};
      if (ctx.path === '/sign-in/oauth2') {
        ctx.body.additionalData = {
          ...additionalData,
          ...createPlatformOidcNonceBinding(nonce, provider.providerKey),
        };
      }
      return {
        nonce,
        // DingTalk only renders its authorization (QR / account) screen with prompt=consent.
        // It has no `prompt=login` / `max_age` equivalent, so admin reauth degrades to an
        // explicit re-consent click here rather than a forced re-authentication.
        prompt: 'consent',
      };
    },
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    disableImplicitSignUp: !provider.autoProvision,
    disableSignUp: !provider.autoProvision,
    // Enterprise directory is authoritative: refresh name/avatar each login.
    overrideUserInfo: true,
    getToken: async ({ code, redirectURI: callbackRedirectURI }) => {
      let isAccountLink = false;
      try {
        isAccountLink = (await readOAuthState())?.link !== undefined;
      } catch {
        // Direct adapter calls have no Better Auth request state; observability stays best-effort.
      }
      if (isAccountLink) await suppressPlatformOidcLoginObservation();
      else await markPlatformOidcLoginStage('token_exchange');
      try {
        if (callbackRedirectURI !== undefined && callbackRedirectURI !== betterAuthCallbackURI) {
          throw new Error('PLATFORM_DINGTALK_TOKEN_RESPONSE_INVALID');
        }
        const token = await exchangeDingTalkAuthorizationCode({
          clientId: provider.clientId,
          clientSecret: provider.clientSecret,
          code,
          outbound,
        });
        // Organisation allowlist: only enterprises the administrator captured may sign in.
        // Enforced here — before the profile read and before any user/account lookup or write —
        // so a member of a non-allowed enterprise never reaches provisioning. An empty
        // allowlist allows nobody; a token without a corpId is a rejection, not a pass.
        assertDingTalkCorpAllowed({ actual: token.corpId, allowlist: allowedCorps });
        return {
          accessToken: token.accessToken,
          accessTokenExpiresAt: token.expiresIn
            ? new Date(Date.now() + token.expiresIn * 1000)
            : undefined,
          expiresIn: token.expiresIn,
          raw: { corpId: token.corpId },
          refreshToken: token.refreshToken,
          scopes: [...provider.scopes],
          tokenType: 'Bearer',
        };
      } catch (error) {
        await markPlatformOidcLoginStage('token_exchange', 'token_invalid');
        await observePlatformOidcLoginFailure();
        throw error;
      }
    },
    getUserInfo: async (tokens) => {
      if (!tokens.accessToken) {
        await markPlatformOidcLoginStage('token_exchange', 'token_invalid');
        await observePlatformOidcLoginFailure();
        throw new Error('PLATFORM_DINGTALK_TOKEN_INVALID');
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
        throw new Error('PLATFORM_DINGTALK_STATE_INVALID');
      }

      await markPlatformOidcLoginStage('userinfo');
      let profile: Awaited<ReturnType<typeof fetchDingTalkUserProfile>>;
      try {
        profile = await fetchDingTalkUserProfile({ accessToken: tokens.accessToken, outbound });
      } catch (error) {
        await markPlatformOidcLoginStage('userinfo', 'userinfo_invalid');
        await observePlatformOidcLoginFailure();
        throw error;
      }

      let claims: DingTalkClaims;
      try {
        claims = toDingTalkClaims(profile, { providerKey: provider.providerKey });
      } catch (error) {
        await markPlatformOidcLoginStage('userinfo', 'subject_mismatch');
        await observePlatformOidcLoginFailure();
        throw error;
      }

      await markPlatformOidcLoginStage('authenticated');
      const flowId =
        typeof oauthState?.oauthState === 'string' && oauthState.oauthState
          ? oauthState.oauthState
          : undefined;
      try {
        const mapped = mapDingTalkProfileToUser(provider, claims);
        stashPlatformGroupRoleMapping(provider, claims, mapped.id, flowId);
      } catch (error) {
        await markPlatformOidcLoginStage('authenticated', 'claim_invalid');
        await observePlatformOidcLoginFailure();
        throw error;
      }
      return claims;
    },
    issuer: provider.issuer,
    mapProfileToUser: (profile) => mapDingTalkProfileToUser(provider, profile),
    // DingTalk's OAuth 2.0 endpoint does not implement RFC 7636; sending a code challenge it
    // never echoes would leave Better Auth holding a verifier the token call cannot use.
    pkce: false,
    providerId: provider.providerKey,
    // The shim, not Better Auth's callback — see the note above.
    redirectURI: dingtalkRedirectURI,
    // DingTalk does not implement RFC 9207, so no `iss` is expected on the callback.
    requireIssuerValidation: false,
    scopes: provider.scopes,
    tokenUrl: DINGTALK_TOKEN_ENDPOINT,
  };
};
