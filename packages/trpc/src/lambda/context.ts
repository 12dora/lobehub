import { type Context as OtContext } from '@lobechat/observability-otel/api';
import { type ClientSecretPayload } from '@lobechat/types';
import { parse } from 'cookie';
import debug from 'debug';
import { type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { isEnterpriseFlagTruthy } from '@/const/platform/featureFlags';
import { getServerDB } from '@/database/core/db-adaptor';
import { ApiKeyModel } from '@/database/models/apiKey';
import { authEnv, LOBE_CHAT_OIDC_AUTH_HEADER } from '@/envs/auth';
import { extractTraceContext } from '@/libs/observability/traceparent';
import { assertUserActive, isOIDCUserInactiveError } from '@/libs/oidc-provider/access-control';
import { validateOIDCJWT } from '@/libs/oidc-provider/jwt';
import { isApiKeyExpired, validateApiKeyFormat } from '@/utils/apiKey';

// Create context logger namespace
const log = debug('lobe-trpc:lambda:context');
const LOBE_CHAT_API_KEY_HEADER = 'X-API-Key';

/**
 * How the principal authenticated. Used for M04 reauth gates:
 * API keys never satisfy recent interactive reauthentication.
 */
export type AuthMethod = 'better-auth' | 'oidc' | 'api-key' | 'dev-mock';

/** Flag-gated platform security checks (ban + authInvalidatedAt). Flag-off = upstream parity. */
const isPlatformAdminSecurityOn = (): boolean =>
  isEnterpriseFlagTruthy(process.env.ENABLE_PLATFORM_ADMIN) ||
  isEnterpriseFlagTruthy(process.env.ENABLE_ENTERPRISE_ADMIN);

const extractClientIp = (request: NextRequest): string | undefined => {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const ip = forwardedFor.split(',')[0]?.trim();
    if (ip) return ip;
  }

  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  return undefined;
};

/**
 * Trusted interactive reauth time from OIDC claims.
 * Only `auth_time` (OIDC AuthN Time) — never access-token `iat` (refresh issues new iat).
 * Do not log token claims.
 */
export const extractOidcAuthenticatedAt = (
  tokenData: Record<string, unknown> | null | undefined,
): Date | null => {
  if (!tokenData) return null;
  const authTime = tokenData.auth_time;
  if (typeof authTime === 'number' && Number.isFinite(authTime)) {
    return new Date(authTime * 1000);
  }
  // Missing auth_time → fail closed for reauth (null).
  return null;
};

/** Token iat for authInvalidatedAt cutoff only (not reauth). */
export const extractOidcCredentialIssuedAt = (
  tokenData: Record<string, unknown> | null | undefined,
): Date | null => {
  if (!tokenData) return null;
  const iat = tokenData.iat;
  if (typeof iat === 'number' && Number.isFinite(iat)) {
    return new Date(iat * 1000);
  }
  return null;
};

const validateApiKeyUserId = async (apiKey: string): Promise<string | null> => {
  if (!validateApiKeyFormat(apiKey)) return null;

  try {
    const db = await getServerDB();
    const apiKeyRecord = await ApiKeyModel.findByKey(db, apiKey);

    if (!apiKeyRecord) return null;
    if (!apiKeyRecord.enabled) return null;
    if (isApiKeyExpired(apiKeyRecord.expiresAt)) return null;

    // Ban / invalidation: only when platform admin security is on.
    if (isPlatformAdminSecurityOn()) {
      try {
        // API keys have no interactive credential time; ban still applies.
        // authInvalidatedAt without credential time fails closed — API keys after revoke
        // are rejected when cutoff is set.
        await assertUserActive(db, apiKeyRecord.userId, {
          credentialIssuedAt: apiKeyRecord.createdAt ?? null,
        });
      } catch (error) {
        if (isOIDCUserInactiveError(error)) {
          log('API key user is banned/inactive; rejecting');
          return null;
        }
        throw error;
      }
    }

    const userApiKeyModel = new ApiKeyModel(
      db,
      apiKeyRecord.userId,
      apiKeyRecord.workspaceId ?? undefined,
    );
    void userApiKeyModel.updateLastUsed(apiKeyRecord.id).catch((error) => {
      log('Failed to update API key last used timestamp: %O', error);
      console.error('Failed to update API key last used timestamp:', error);
    });

    return apiKeyRecord.userId;
  } catch (error) {
    log('API key authentication failed: %O', error);
    console.error('API key authentication failed, trying other methods:', error);
    return null;
  }
};

export interface OIDCAuth {
  // Other OIDC information that might be needed (optional, as payload contains all info)
  [key: string]: any;
  // OIDC token data (now the complete payload)
  payload: any;
  // User ID
  sub: string;
}

export interface AuthContext {
  /**
   * Trusted interactive auth timestamp:
   * - Better Auth: session.createdAt (login / re-login)
   * - OIDC: auth_time claim only (never access-token iat)
   * - API key: always null (never qualifies for reauth)
   * Never trust client-provided headers for this.
   */
  authenticatedAt?: Date | null;
  /** Authentication method for the current principal (server-trusted). */
  authMethod?: AuthMethod | null;
  clientIp?: string | null;
  jwtPayload?: ClientSecretPayload | null;
  marketAccessToken?: string;
  // Add OIDC authentication information
  oidcAuth?: OIDCAuth | null;
  resHeaders?: Headers;
  /** Better Auth session id only — never the session token. */
  sessionId?: string | null;
  traceContext?: OtContext;
  userAgent?: string;
  userId?: string | null;
  workspaceId?: string | null;
}

/**
 * Inner function for `createContext` where we create the context.
 * This is useful for testing when we don't want to mock Next.js' request/response
 */
export const createContextInner = async (params?: {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod | null;
  clientIp?: string | null;
  marketAccessToken?: string;
  oidcAuth?: OIDCAuth | null;
  sessionId?: string | null;
  traceContext?: OtContext;
  userAgent?: string;
  userId?: string | null;
  workspaceId?: string | null;
}): Promise<AuthContext> => {
  log('createContextInner called with params: %O', params);
  const responseHeaders = new Headers();

  return {
    authenticatedAt: params?.authenticatedAt ?? null,
    authMethod: params?.authMethod ?? null,
    clientIp: params?.clientIp,
    marketAccessToken: params?.marketAccessToken,
    oidcAuth: params?.oidcAuth,
    resHeaders: responseHeaders,
    sessionId: params?.sessionId ?? null,
    traceContext: params?.traceContext,
    userAgent: params?.userAgent,
    userId: params?.userId,
    workspaceId: params?.workspaceId,
  };
};

export type LambdaContext = Awaited<ReturnType<typeof createContextInner>>;

/**
 * Creates context for an incoming request
 * @link https://trpc.io/docs/v11/context
 */
export const createLambdaContext = async (request: NextRequest): Promise<LambdaContext> => {
  // we have a special header to debug the api endpoint in development mode
  // IT WON'T GO INTO PRODUCTION ANYMORE
  const isDebugApi = request.headers.get('lobe-auth-dev-backend-api') === '1';
  const isMockUser = process.env.ENABLE_MOCK_DEV_USER === '1';

  if (process.env.NODE_ENV === 'development' && (isDebugApi || isMockUser)) {
    return createContextInner({
      // Dev mock is treated as freshly authenticated so local admin mutations work.
      authenticatedAt: new Date(),
      authMethod: 'dev-mock',
      userId: process.env.MOCK_DEV_USER_ID,
    });
  }

  log('createLambdaContext called for request');
  // for API-response caching see https://trpc.io/docs/v11/caching

  const userAgent = request.headers.get('user-agent') || undefined;
  const clientIp = extractClientIp(request);

  // get marketAccessToken from cookies
  const cookieHeader = request.headers.get('cookie');
  const cookies = cookieHeader ? parse(cookieHeader) : {};
  const marketAccessToken = cookies['mp_token'];
  // Extract upstream trace context for parent linking
  const traceContext = extractTraceContext(request.headers);

  log('marketAccessToken from cookie:', marketAccessToken ? '[HIDDEN]' : 'undefined');
  const workspaceId = request.headers.get('X-Workspace-Id')?.trim() || undefined;

  const commonContext = {
    clientIp,
    marketAccessToken,
    userAgent,
    workspaceId,
  };

  const securityOn = isPlatformAdminSecurityOn();

  const apiKeyToken = request.headers.get(LOBE_CHAT_API_KEY_HEADER)?.trim();
  log('X-API-Key header: %s', apiKeyToken ? 'exists' : 'not found');

  if (apiKeyToken) {
    const apiKeyUserId = await validateApiKeyUserId(apiKeyToken);

    if (!apiKeyUserId) {
      log('API key authentication failed; rejecting request without fallback auth');

      return createContextInner({
        ...commonContext,
        authMethod: null,
        traceContext,
        userId: null,
      });
    }

    log('API key authentication successful, userId: %s', apiKeyUserId);

    return createContextInner({
      ...commonContext,
      // API keys never qualify as recent interactive reauthentication.
      authenticatedAt: null,
      authMethod: 'api-key',
      traceContext,
      userId: apiKeyUserId,
    });
  }

  let userId;
  let oidcAuth;

  // Prioritize checking for OIDC authentication (both standard Authorization and custom Oidc-Auth headers)
  if (authEnv.ENABLE_OIDC) {
    log('OIDC enabled, attempting OIDC authentication');
    const oidcAuthToken = request.headers.get(LOBE_CHAT_OIDC_AUTH_HEADER);
    log('Oidc-Auth header: %s', oidcAuthToken ? 'exists' : 'not found');

    try {
      if (oidcAuthToken) {
        // Validate the stateless JWT first, then check the current user state
        // so banned/deleted accounts cannot keep using an already-issued token.
        const tokenInfo = await validateOIDCJWT(oidcAuthToken);

        oidcAuth = {
          payload: tokenInfo.tokenData,
          ...tokenInfo.tokenData, // Spread payload into oidcAuth
          sub: tokenInfo.userId, // Use tokenData as payload
        };
        userId = tokenInfo.userId;

        if (securityOn) {
          const db = await getServerDB();
          const credentialIssuedAt = extractOidcCredentialIssuedAt(
            tokenInfo.tokenData as Record<string, unknown>,
          );
          await assertUserActive(db, userId, { credentialIssuedAt });
        }
        log('OIDC authentication successful, userId: %s', userId);

        // Reauth signal: auth_time only — never iat (refresh mints new iat).
        const authenticatedAt = extractOidcAuthenticatedAt(
          tokenInfo.tokenData as Record<string, unknown>,
        );

        log('OIDC authentication successful, creating context and returning');
        return createContextInner({
          authenticatedAt,
          authMethod: 'oidc',
          oidcAuth,
          ...commonContext,
          traceContext,
          userId,
        });
      }
    } catch (error) {
      if (isOIDCUserInactiveError(error)) {
        log('OIDC user is inactive, rejecting request without fallback auth');
        console.error('OIDC authentication failed for inactive user:', error);
        return createContextInner({
          ...commonContext,
          traceContext,
          userId: null,
        });
      }

      // If OIDC authentication fails, log error and continue with other authentication methods
      if (oidcAuthToken) {
        log('OIDC authentication failed, error: %O', error);
        console.error('OIDC authentication failed, trying other methods:', error);
      }
    }
  }

  // If OIDC is not enabled or validation fails, try Better Auth authentication
  log('Attempting Better Auth authentication');
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (session && session?.user?.id) {
      userId = session.user.id;
      log('Better Auth authentication successful, userId: %s', userId);

      const rawCreatedAt = session.session?.createdAt;
      const sessionCreatedAt =
        rawCreatedAt instanceof Date ? rawCreatedAt : rawCreatedAt ? new Date(rawCreatedAt) : null;
      const authenticatedAt =
        sessionCreatedAt && !Number.isNaN(sessionCreatedAt.getTime()) ? sessionCreatedAt : null;
      const sessionId = typeof session.session?.id === 'string' ? session.session.id : null;

      // Cookie cache can return banned/revoked sessions; re-check DB when security on.
      if (securityOn) {
        const db = await getServerDB();
        try {
          await assertUserActive(db, userId, {
            credentialIssuedAt: authenticatedAt,
          });
        } catch (error) {
          if (isOIDCUserInactiveError(error)) {
            log('Better Auth user is banned/inactive/invalidated; rejecting');
            return createContextInner({
              ...commonContext,
              traceContext,
              userId: null,
            });
          }
          throw error;
        }
      }

      return createContextInner({
        ...commonContext,
        authenticatedAt,
        authMethod: 'better-auth',
        sessionId,
        traceContext,
        userId,
      });
    } else {
      log('Better Auth authentication failed, no valid session');
    }

    return createContextInner({
      ...commonContext,
      traceContext,
      userId,
    });
  } catch (e) {
    log('Better Auth authentication error: %O', e);
    console.error('better auth err', e);
  }

  // Final return, userId may be undefined
  log(
    'All authentication methods attempted, returning final context, userId: %s',
    userId || 'not authenticated',
  );
  return createContextInner({ ...commonContext, traceContext, userId });
};
