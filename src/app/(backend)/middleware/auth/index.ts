import type { ChatCompletionErrorPayload } from '@lobechat/model-runtime';
import { AgentRuntimeError } from '@lobechat/model-runtime';
import { context as otContext } from '@lobechat/observability-otel/api';
import type { ClientSecretPayload } from '@lobechat/types';
import { ChatErrorType } from '@lobechat/types';

import { auth } from '@/auth';
import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';
import { LOBE_CHAT_OIDC_AUTH_HEADER } from '@/envs/auth';
import { extractTraceContext, injectActiveTraceHeaders } from '@/libs/observability/traceparent';
import { assertOIDCUserActive } from '@/libs/oidc-provider/access-control';
import { validateOIDCJWT } from '@/libs/oidc-provider/jwt';
import { assertUserActiveCached } from '@/libs/oidc-provider/userActiveCache';
import { LOBE_CHAT_API_KEY_HEADER, validateApiKeyAuth } from '@/libs/trpc/lambda/context';
import { createErrorResponse } from '@/utils/errorResponse';

type RequestOptions = { params: Promise<{ provider?: string }> };

export type RequestHandler = (
  req: Request,
  options: RequestOptions & {
    jwtPayload: ClientSecretPayload;
    serverDB: LobeChatDatabase;
    userId: string;
  },
) => Promise<Response>;

interface OIDCClientDebugInfo {
  clientId?: string;
  payload?: Record<string, unknown>;
}

const isUnauthorizedAuthError = (error: unknown) => {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'UNAUTHORIZED';
};

/**
 * Decode JWT payload for debugging only.
 * The decoded payload must never be trusted for authorization decisions.
 */
const getOIDCClientDebugInfo = (token?: string | null): OIDCClientDebugInfo => {
  if (!token) return {};

  const [, payload] = token.split('.');
  if (!payload) return {};

  try {
    const normalizedPayload = payload.replaceAll('-', '+').replaceAll('_', '/');
    const decodedPayload = JSON.parse(Buffer.from(normalizedPayload, 'base64').toString('utf8')) as
      Record<string, unknown> | undefined;

    const clientId =
      typeof decodedPayload?.client_id === 'string' ? decodedPayload.client_id : undefined;

    return { clientId, payload: decodedPayload };
  } catch {
    return {};
  }
};

export const checkAuth =
  (handler: RequestHandler) => async (req: Request, options: RequestOptions) => {
    // Clone the request to avoid "Response body object should not be disturbed or locked" error
    // in Next.js 16 when the body stream has been consumed by Next.js internal mechanisms
    // This ensures the handler can safely read the request body
    const clonedReq = req.clone();

    // Get serverDB for database access
    const serverDB = await getServerDB();

    // we have a special header to debug the api endpoint in development mode
    const isDebugApi = req.headers.get('lobe-auth-dev-backend-api') === '1';
    const isMockUser = process.env.ENABLE_MOCK_DEV_USER === '1';
    if (process.env.NODE_ENV === 'development' && (isDebugApi || isMockUser)) {
      const mockUserId = process.env.MOCK_DEV_USER_ID || 'DEV_USER';
      return handler(clonedReq, {
        ...options,
        jwtPayload: { userId: mockUserId },
        serverDB,
        userId: mockUserId,
      });
    }

    let userId: string;

    try {
      // API key (official CLI `X-API-Key`) — same helper and exclusive-no-fallback
      // semantics as tRPC `createLambdaContext`. Must run before OIDC / session.
      // Presence (`!== null`) is the exclusivity key: empty/whitespace still 401,
      // never fall through to OIDC/session.
      const apiKeyHeader = req.headers.get(LOBE_CHAT_API_KEY_HEADER);
      if (apiKeyHeader !== null) {
        const apiKeyAuth = await validateApiKeyAuth(apiKeyHeader.trim());
        if (!apiKeyAuth) {
          throw AgentRuntimeError.createError(ChatErrorType.Unauthorized);
        }
        userId = apiKeyAuth.userId;
      } else {
        // OIDC authentication (CLI)
        const oidcAuthorization = req.headers.get(LOBE_CHAT_OIDC_AUTH_HEADER);
        if (oidcAuthorization) {
          const oidc = await validateOIDCJWT(oidcAuthorization);
          userId = oidc.userId;
          await assertOIDCUserActive(serverDB, userId);
        } else {
          // Better Auth session authentication (web). Cookie-cache can return a
          // signed session after the auth_sessions row is gone — fail closed on
          // a live DB row. Backend failures must stay 500, not 401.
          const session = await auth.api.getSession({
            headers: req.headers,
          });

          if (!session?.user?.id) {
            throw AgentRuntimeError.createError(ChatErrorType.Unauthorized);
          }

          userId = session.user.id;
          const rawCreatedAt = session.session?.createdAt;
          const sessionCreatedAt =
            rawCreatedAt instanceof Date
              ? rawCreatedAt
              : rawCreatedAt
                ? new Date(rawCreatedAt)
                : null;
          const credentialIssuedAt =
            sessionCreatedAt && !Number.isNaN(sessionCreatedAt.getTime()) ? sessionCreatedAt : null;
          const sessionId = typeof session.session?.id === 'string' ? session.session.id : null;
          await assertUserActiveCached(serverDB, userId, { credentialIssuedAt, sessionId });
        }
      }
    } catch (e) {
      const params = await options.params;
      const oidcAuthorization = req.headers.get(LOBE_CHAT_OIDC_AUTH_HEADER);

      // Only log OIDC auth failures — better-auth session failures are a common
      // baseline (unauthenticated browser hits) and would otherwise flood logs.
      // Skip when X-API-Key was present: that path is exclusive (no OIDC fallback).
      if (oidcAuthorization && req.headers.get(LOBE_CHAT_API_KEY_HEADER) === null) {
        const oidcDebugInfo = getOIDCClientDebugInfo(oidcAuthorization);

        console.info('[auth] OIDC authentication failed', {
          clientId: oidcDebugInfo.clientId,
          code: (e as { code?: string })?.code,
          path: new URL(req.url).pathname,
          provider: params?.provider,
          userAgent: req.headers.get('user-agent'),
          xClientType: req.headers.get('x-client-type'),
        });
      }

      // if the error is not a ChatCompletionErrorPayload, it means the application error
      if (!(e as ChatCompletionErrorPayload).errorType) {
        if (isUnauthorizedAuthError(e)) {
          return createErrorResponse(ChatErrorType.Unauthorized, {
            error: e,
            provider: params?.provider,
          });
        }

        // other issue will be internal server error
        console.error(e);
        return createErrorResponse(ChatErrorType.InternalServerError, {
          error: e,
          provider: params?.provider,
        });
      }

      const {
        errorType = ChatErrorType.InternalServerError,
        error: errorContent,
        ...res
      } = e as ChatCompletionErrorPayload;

      const error = errorContent || e;

      return createErrorResponse(errorType, { error, ...res, provider: params?.provider });
    }

    const jwtPayload: ClientSecretPayload = { userId };

    const extractedContext = extractTraceContext(req.headers);

    const res = await otContext.with(extractedContext, () =>
      handler(clonedReq, { ...options, jwtPayload, serverDB, userId }),
    );

    // Only inject trace headers when the handler returns a Response
    // NOTICE: this is related to src/app/(backend)/webapi/chat/[provider]/route.test.ts
    if (!(res instanceof Response)) {
      console.warn(
        'Response is not an instance of Response, skipping trace header injection. Possibly bug or mocked response in tests, please check and make sure this is intended behavior.',
      );
      return res;
    }

    try {
      const headers = new Headers(res.headers);
      const traceparent = injectActiveTraceHeaders(headers);
      if (!traceparent) {
        return res;
      }

      return new Response(res.body, { headers, status: res.status, statusText: res.statusText });
    } catch (err) {
      console.error('Failed to inject trace headers:', err);
      return res;
    }
  };
