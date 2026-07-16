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
 * Only `auth_time` — never access-token `iat` (refresh mints a new iat).
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
  return null;
};

/** Token iat for security-epoch / authInvalidatedAt cutoff only (not reauth). */
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

const validateApiKeyAuth = async (
  apiKey: string,
): Promise<{ credentialIssuedAt: Date | null; userId: string } | null> => {
  if (!validateApiKeyFormat(apiKey)) return null;

  try {
    const db = await getServerDB();
    const apiKeyRecord = await ApiKeyModel.findByKey(db, apiKey);

    if (!apiKeyRecord) return null;
    if (!apiKeyRecord.enabled) return null;
    if (isApiKeyExpired(apiKeyRecord.expiresAt)) return null;

    const credentialIssuedAt =
      apiKeyRecord.createdAt instanceof Date
        ? apiKeyRecord.createdAt
        : apiKeyRecord.createdAt
          ? new Date(apiKeyRecord.createdAt)
          : null;

    if (isPlatformAdminSecurityOn()) {
      try {
        await assertUserActive(db, apiKeyRecord.userId, { credentialIssuedAt });
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

    return { credentialIssuedAt, userId: apiKeyRecord.userId };
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
   * Trusted interactive auth timestamp (reauth gates only):
   * - Better Auth: session.createdAt (login / security rotation after includeCurrent preserve)
   * - OIDC: auth_time claim only
   * - API key: always null
   */
  authenticatedAt?: Date | null;
  /** Authentication method for the current principal (server-trusted). */
  authMethod?: AuthMethod | null;
  clientIp?: string | null;
  /**
   * Trusted credential issuance time for ban / authInvalidatedAt cutoff (R2-02):
   * - Better Auth: session.createdAt (security issuance; rotated past cutoff when preserved)
   * - OIDC: token iat
   * - API key: api key createdAt
   * Never substitute authenticatedAt / auth_time here.
   */
  credentialIssuedAt?: Date | null;
  jwtPayload?: ClientSecretPayload | null;
  marketAccessToken?: string;
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
  credentialIssuedAt?: Date | null;
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
    credentialIssuedAt: params?.credentialIssuedAt ?? null,
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
  const isDebugApi = request.headers.get('lobe-auth-dev-backend-api') === '1';
  const isMockUser = process.env.ENABLE_MOCK_DEV_USER === '1';

  if (process.env.NODE_ENV === 'development' && (isDebugApi || isMockUser)) {
    const now = new Date();
    return createContextInner({
      authenticatedAt: now,
      authMethod: 'dev-mock',
      credentialIssuedAt: now,
      userId: process.env.MOCK_DEV_USER_ID,
    });
  }

  log('createLambdaContext called for request');

  const userAgent = request.headers.get('user-agent') || undefined;
  const clientIp = extractClientIp(request);

  const cookieHeader = request.headers.get('cookie');
  const cookies = cookieHeader ? parse(cookieHeader) : {};
  const marketAccessToken = cookies['mp_token'];
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
    const apiKeyAuth = await validateApiKeyAuth(apiKeyToken);

    if (!apiKeyAuth) {
      log('API key authentication failed; rejecting request without fallback auth');

      return createContextInner({
        ...commonContext,
        authMethod: null,
        traceContext,
        userId: null,
      });
    }

    log('API key authentication successful, userId: %s', apiKeyAuth.userId);

    return createContextInner({
      ...commonContext,
      authenticatedAt: null,
      authMethod: 'api-key',
      credentialIssuedAt: apiKeyAuth.credentialIssuedAt,
      traceContext,
      userId: apiKeyAuth.userId,
    });
  }

  let userId;
  let oidcAuth;

  if (authEnv.ENABLE_OIDC) {
    log('OIDC enabled, attempting OIDC authentication');
    const oidcAuthToken = request.headers.get(LOBE_CHAT_OIDC_AUTH_HEADER);
    log('Oidc-Auth header: %s', oidcAuthToken ? 'exists' : 'not found');

    try {
      if (oidcAuthToken) {
        const tokenInfo = await validateOIDCJWT(oidcAuthToken);

        oidcAuth = {
          payload: tokenInfo.tokenData,
          ...tokenInfo.tokenData,
          sub: tokenInfo.userId,
        };
        userId = tokenInfo.userId;

        const credentialIssuedAt = extractOidcCredentialIssuedAt(
          tokenInfo.tokenData as Record<string, unknown>,
        );

        if (securityOn) {
          const db = await getServerDB();
          await assertUserActive(db, userId, { credentialIssuedAt });
        }
        log('OIDC authentication successful, userId: %s', userId);

        const authenticatedAt = extractOidcAuthenticatedAt(
          tokenInfo.tokenData as Record<string, unknown>,
        );

        return createContextInner({
          authenticatedAt,
          authMethod: 'oidc',
          credentialIssuedAt,
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

      if (oidcAuthToken) {
        log('OIDC authentication failed, error: %O', error);
        console.error('OIDC authentication failed, trying other methods:', error);
      }
    }
  }

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
      const issuedAt =
        sessionCreatedAt && !Number.isNaN(sessionCreatedAt.getTime()) ? sessionCreatedAt : null;
      const sessionId = typeof session.session?.id === 'string' ? session.session.id : null;

      // Security epoch: credentialIssuedAt = original session.createdAt (never rewritten on revoke).
      // Reauth: authenticatedAt = same original login time (session exception does not refresh it).
      // Cutoff exception: trusted sessionId may match authInvalidatedExcludedSessionId.
      if (securityOn) {
        const db = await getServerDB();
        try {
          await assertUserActive(db, userId, {
            credentialIssuedAt: issuedAt,
            sessionId,
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
        authenticatedAt: issuedAt,
        authMethod: 'better-auth',
        credentialIssuedAt: issuedAt,
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

  log(
    'All authentication methods attempted, returning final context, userId: %s',
    userId || 'not authenticated',
  );
  return createContextInner({ ...commonContext, traceContext, userId });
};
