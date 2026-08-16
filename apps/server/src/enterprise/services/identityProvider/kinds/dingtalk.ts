import {
  buildDingTalkSyntheticEmail,
  DINGTALK_IDENTITY_PROVIDER_ISSUER,
  isDingTalkCorpAllowed,
  isDingTalkIdentityProviderIssuer,
  type PlatformIdentityProviderAllowedCorp,
  type PlatformOidcDiscoveryMetadata,
} from '@lobechat/types';
import { z } from 'zod';

import type { SafeOutboundHttpClient } from '../../../security/outboundHttp';

/**
 * DingTalk (钉钉) OAuth 2.0 adapter.
 *
 * DingTalk is deliberately NOT an OpenID Provider:
 * - it publishes no `/.well-known/openid-configuration`, so endpoints are static here;
 * - its token endpoint takes a JSON body and answers with camelCase fields and no `id_token`;
 * - its profile endpoint authenticates with `x-acs-dingtalk-access-token`, not `Bearer`;
 * - it does not implement PKCE (RFC 7636);
 * - it usually returns no email at all.
 *
 * Every deviation above is contained in this module. The strict-OIDC kinds (`authentik`,
 * `generic_oidc`) never reach any code path defined here.
 *
 * Docs: https://open.dingtalk.com/document/orgapp/obtain-identity-credentials
 */

export const DINGTALK_AUTHORIZATION_ENDPOINT = 'https://login.dingtalk.com/oauth2/auth';
export const DINGTALK_TOKEN_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
export const DINGTALK_USERINFO_ENDPOINT = 'https://api.dingtalk.com/v1.0/contact/users/me';

/**
 * DingTalk signs nothing, so no JWKS exists. The runtime never verifies an id_token for this
 * kind; the `.invalid` sentinel (same convention as `BETTER_AUTH_UNUSED_TOKEN_ENDPOINT`) makes a
 * hypothetical future caller fail closed instead of silently trusting a resolvable host.
 */
export const DINGTALK_UNUSED_JWKS_URI = 'https://platform-dingtalk-jwks.invalid/';

const REQUEST_TIMEOUT_MS = 5000;
const RESPONSE_MAX_BYTES = 64 * 1024;

const tokenResponseSchema = z
  .object({
    accessToken: z.string().min(1).max(32_768),
    corpId: z.string().max(256).optional(),
    expireIn: z.number().int().nonnegative().optional(),
    refreshToken: z.string().min(1).max(32_768).optional(),
  })
  .passthrough();

const userProfileSchema = z
  .object({
    avatarUrl: z.string().max(4096).optional(),
    email: z.string().max(320).optional(),
    mobile: z.string().max(64).optional(),
    nick: z.string().max(256).optional(),
    openId: z.string().max(256).optional(),
    stateCode: z.string().max(16).optional(),
    unionId: z.string().max(256).optional(),
  })
  .passthrough();

export interface DingTalkTokenResult {
  accessToken: string;
  /** Organisation the access token belongs to. Absent unless the `corpid` scope was granted. */
  corpId?: string;
  expiresIn?: number;
  refreshToken?: string;
}

export type DingTalkUserProfile = z.infer<typeof userProfileSchema>;

/** Normalised DingTalk profile in the shape Better Auth and the claim mapping consume. */
export interface DingTalkClaims extends DingTalkUserProfile {
  email: string;
  emailVerified: boolean;
  id: string;
  nick: string;
  sub: string;
}

const failure = (code: string, cause?: unknown): Error =>
  new Error(code, cause === undefined ? undefined : { cause });

const isJsonResponse = (
  response: Awaited<ReturnType<SafeOutboundHttpClient['fetch']>>,
): boolean => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return contentType === 'application/json' || contentType?.endsWith('+json') === true;
};

/** Which DingTalk call failed. The two stages have completely different remedies. */
export type DingTalkApiStage = 'profile' | 'token';

/**
 * A DingTalk API rejection, carrying enough detail for an administrator to act.
 *
 * DingTalk answers errors with `{ code, message, requestid }`. Only `code` is propagated: it is a
 * stable machine token (`invalidParameter.idOrSecret.notFound`, `Forbidden.AccessDenied.…`) that
 * maps to a concrete fix, whereas `message` is untrusted third-party free text. Nothing here ever
 * carries the client secret, the authorization code, or an access token.
 */
export class DingTalkApiError extends Error {
  constructor(
    message: string,
    readonly detail: {
      /** Sanitized DingTalk error code, when the body carried a usable one. */
      dingtalkCode?: string;
      stage: DingTalkApiStage;
      status?: number;
    },
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DingTalkApiError';
  }
}

/** DingTalk error codes are dotted identifiers; anything else is discarded. */
const DINGTALK_ERROR_CODE_PATTERN = /^[A-Z][\w.-]{0,63}$/i;

const parseDingTalkErrorCode = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' && DINGTALK_ERROR_CODE_PATTERN.test(code) ? code : undefined;
};

/** Best-effort error-body read; a failure here must never mask the original rejection. */
const readDingTalkErrorCode = async (
  response: Awaited<ReturnType<SafeOutboundHttpClient['fetch']>>,
): Promise<string | undefined> => {
  if (!isJsonResponse(response) || response.truncated) return undefined;
  try {
    return parseDingTalkErrorCode(await response.json());
  } catch {
    return undefined;
  }
};

/**
 * Static stand-in for the discovery document DingTalk does not publish.
 * `issuer` echoes the stored issuer so the snapshot invariant
 * (`oidcMetadata.issuer === provider.issuer`) keeps holding for this kind.
 */
export const buildDingTalkDiscoveryMetadata = (
  issuer: string = DINGTALK_IDENTITY_PROVIDER_ISSUER,
): PlatformOidcDiscoveryMetadata => ({
  authorizationEndpoint: DINGTALK_AUTHORIZATION_ENDPOINT,
  authorizationResponseIssParameterSupported: false,
  codeChallengeMethodsSupported: [],
  idTokenSigningAlgValuesSupported: [],
  // Fail closed: a non-DingTalk issuer must never be materialized as "DingTalk, unrestricted".
  issuer: assertDingTalkIssuer(issuer),
  jwksUri: DINGTALK_UNUSED_JWKS_URI,
  responseTypesSupported: ['code'],
  scopesSupported: ['openid', 'corpid'],
  subjectTypesSupported: ['public'],
  tokenEndpoint: DINGTALK_TOKEN_ENDPOINT,
  // DingTalk carries the client credentials in the JSON token body — morally client_secret_post.
  tokenEndpointAuthMethodsSupported: ['client_secret_post'],
  userinfoEndpoint: DINGTALK_USERINFO_ENDPOINT,
});

/**
 * Fail-closed issuer guard. A DingTalk provider's issuer must be exactly
 * `https://login.dingtalk.com`; anything else is a misconfigured or tampered row.
 */
export const assertDingTalkIssuer = (
  issuer: string | null | undefined,
  errorCode = 'PLATFORM_DINGTALK_ISSUER_INVALID',
): string => {
  if (!isDingTalkIdentityProviderIssuer(issuer)) throw failure(errorCode);
  return issuer as string;
};

/**
 * Organisation allowlist gate — the whole access-control decision for this kind.
 *
 * Called immediately after the token exchange and BEFORE any profile read, user lookup or
 * account write, so a member of a non-allowed enterprise never touches user state.
 *
 * Fail-closed in every direction: an empty allowlist allows nobody, and a token response with
 * no `corpId` (the `corpid` scope was not granted) is a rejection rather than a pass.
 */
export const assertDingTalkCorpAllowed = (input: {
  actual: string | undefined;
  allowlist: readonly PlatformIdentityProviderAllowedCorp[];
  errorCode?: string;
}): void => {
  if (!isDingTalkCorpAllowed(input.actual, input.allowlist)) {
    throw failure(input.errorCode ?? 'PLATFORM_DINGTALK_CORP_NOT_ALLOWED');
  }
};

/** JSON-body code exchange. No `id_token` is issued, so none is required. */
export const exchangeDingTalkAuthorizationCode = async (input: {
  clientId: string;
  clientSecret: string;
  code: string;
  errorCode?: string;
  outbound: SafeOutboundHttpClient;
}): Promise<DingTalkTokenResult> => {
  const errorCode = input.errorCode ?? 'PLATFORM_DINGTALK_TOKEN_RESPONSE_INVALID';
  try {
    const response = await input.outbound.fetch(DINGTALK_TOKEN_ENDPOINT, {
      body: JSON.stringify({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        code: input.code,
        grantType: 'authorization_code',
      }),
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      maxRedirects: 0,
      maxResponseBytes: RESPONSE_MAX_BYTES,
      method: 'POST',
      secretBearing: true,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok || response.truncated || !isJsonResponse(response)) {
      // DingTalk answers a rejected exchange with HTTP 4xx + `{code, message}`; carrying that
      // code out is the difference between "wrong AppSecret" and "redirect URL not registered".
      throw new DingTalkApiError(errorCode, {
        ...(await readDingTalkErrorCode(response).then((code) =>
          code ? { dingtalkCode: code } : {},
        )),
        stage: 'token',
        status: response.status,
      });
    }
    const parsed = tokenResponseSchema.parse(await response.json());
    return {
      accessToken: parsed.accessToken,
      ...(parsed.corpId ? { corpId: parsed.corpId } : {}),
      ...(parsed.expireIn === undefined ? {} : { expiresIn: parsed.expireIn }),
      ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
    };
  } catch (error) {
    if (error instanceof DingTalkApiError) throw error;
    if (error instanceof Error && error.message === errorCode) throw error;
    // A 200 body that is not a usable token response (missing accessToken, wrong shape).
    throw new DingTalkApiError(errorCode, { stage: 'token' }, error);
  }
};

/** Profile read. DingTalk authenticates with its own header, not an OIDC Bearer token. */
export const fetchDingTalkUserProfile = async (input: {
  accessToken: string;
  errorCode?: string;
  outbound: SafeOutboundHttpClient;
}): Promise<DingTalkUserProfile> => {
  const errorCode = input.errorCode ?? 'PLATFORM_DINGTALK_USERINFO_INVALID';
  try {
    const response = await input.outbound.fetch(DINGTALK_USERINFO_ENDPOINT, {
      headers: {
        'Accept': 'application/json',
        'x-acs-dingtalk-access-token': input.accessToken,
      },
      maxRedirects: 0,
      maxResponseBytes: RESPONSE_MAX_BYTES,
      method: 'GET',
      secretBearing: true,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok || response.truncated || !isJsonResponse(response)) {
      // 403 here is almost always the missing 通讯录个人信息读权限 (`Contact.User.Read`) scope —
      // a completely different fix from a credential problem, so it must not collapse into one
      // "remote invalid" bucket.
      throw new DingTalkApiError(errorCode, {
        ...(await readDingTalkErrorCode(response).then((code) =>
          code ? { dingtalkCode: code } : {},
        )),
        stage: 'profile',
        status: response.status,
      });
    }
    return userProfileSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof DingTalkApiError) throw error;
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new DingTalkApiError(errorCode, { stage: 'profile' }, error);
  }
};

export const DINGTALK_APP_TOKEN_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
export const DINGTALK_ORG_AUTH_INFO_ENDPOINT =
  'https://api.dingtalk.com/v1.0/contact/organizations/authInfos';
export const DINGTALK_CORP_NAME_MAX_LENGTH = 128;
/** DingTalk permission that unlocks organisation names (企业信息读权限). */
export const DINGTALK_ORG_READ_SCOPE = 'Contact.Org.Read';

const appTokenResponseSchema = z.object({ accessToken: z.string().min(1) }).passthrough();
const orgAuthInfoResponseSchema = z.object({ corpName: z.string().optional() }).passthrough();

export interface DingTalkCorpNameLookup {
  corpName?: string;
  /** DingTalk permission the app still lacks, when the lookup was refused for that reason. */
  missingScope?: string;
}

/**
 * Best-effort organisation name for a captured corpId, so the admin allowlist can show
 * 「XX 科技有限公司」 instead of an opaque `ding…` id.
 *
 * Uses the app's own access token (AppKey/AppSecret → `/v1.0/oauth2/accessToken`) and the
 * 企业认证信息 endpoint. It needs the `Contact.Org.Read` permission; when DingTalk refuses,
 * the missing scope is reported back so the wizard can tell the admin exactly what to enable.
 * Never throws — a name is a nicety, the capture itself must not depend on it.
 */
export const fetchDingTalkCorpName = async (input: {
  clientId: string;
  clientSecret: string;
  corpId: string;
  outbound: SafeOutboundHttpClient;
}): Promise<DingTalkCorpNameLookup> => {
  try {
    const tokenResponse = await input.outbound.fetch(DINGTALK_APP_TOKEN_ENDPOINT, {
      body: JSON.stringify({ appKey: input.clientId, appSecret: input.clientSecret }),
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      maxRedirects: 0,
      maxResponseBytes: RESPONSE_MAX_BYTES,
      method: 'POST',
      secretBearing: true,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!tokenResponse.ok || tokenResponse.truncated || !isJsonResponse(tokenResponse)) return {};
    const { accessToken } = appTokenResponseSchema.parse(await tokenResponse.json());
    const url = new URL(DINGTALK_ORG_AUTH_INFO_ENDPOINT);
    url.searchParams.set('targetCorpId', input.corpId);
    const response = await input.outbound.fetch(url.toString(), {
      headers: { 'Accept': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
      maxRedirects: 0,
      maxResponseBytes: RESPONSE_MAX_BYTES,
      method: 'GET',
      secretBearing: true,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok || response.truncated || !isJsonResponse(response)) {
      // DingTalk names the missing permission itself (`accessdenieddetail.requiredScopes`).
      const scope = await readDingTalkRequiredScope(response);
      return scope ? { missingScope: scope } : {};
    }
    const parsed = orgAuthInfoResponseSchema.parse(await response.json());
    const corpName = parsed.corpName?.trim();
    return corpName ? { corpName: corpName.slice(0, DINGTALK_CORP_NAME_MAX_LENGTH) } : {};
  } catch {
    return {};
  }
};

const readDingTalkRequiredScope = async (
  response: Awaited<ReturnType<SafeOutboundHttpClient['fetch']>>,
): Promise<string | undefined> => {
  if (!isJsonResponse(response) || response.truncated) return undefined;
  try {
    const body = (await response.json()) as {
      accessdenieddetail?: { requiredScopes?: unknown };
    };
    const scopes = body?.accessdenieddetail?.requiredScopes;
    const first = Array.isArray(scopes) ? scopes[0] : undefined;
    return typeof first === 'string' && DINGTALK_ERROR_CODE_PATTERN.test(first) ? first : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Project a DingTalk profile onto the claim record the shared claim mapping consumes.
 *
 * - subject: `unionId` ONLY, and it is mandatory. `openId` is app-scoped: falling back to it
 *   would rebind an identity to a different account after an AppKey change, so a profile
 *   without a unionId is rejected rather than downgraded.
 * - email: DingTalk usually returns none, so a deterministic address inside the reserved,
 *   per-provider synthetic namespace (`<unionId>@<providerKey>.dingtalk.sso`) is synthesized —
 *   the env-preset Feishu provider does the same, namespaced here so two login methods (or a
 *   local sign-up, which `registrationGuard` blocks on this namespace) cannot collide.
 *   `emailVerified` stays false and DingTalk is excluded from `trustedProviders`, so this
 *   address can never implicitly link onto a pre-existing account.
 */
export const toDingTalkClaims = (
  profile: DingTalkUserProfile,
  input: { errorCode?: string; providerKey: string },
): DingTalkClaims => {
  const errorCode = input.errorCode ?? 'PLATFORM_DINGTALK_SUBJECT_MISSING';
  const subject = profile.unionId?.trim();
  if (!subject) throw failure(errorCode);
  const email = profile.email?.trim().toLowerCase();
  return {
    ...profile,
    email: email || buildDingTalkSyntheticEmail(input.providerKey, subject),
    emailVerified: false,
    id: subject,
    nick: profile.nick?.trim() || subject,
    // `sub` is not a DingTalk field; it is added so the shared claim preview and the
    // OIDC-shaped account-linking path see the same stable subject.
    sub: subject,
  };
};
