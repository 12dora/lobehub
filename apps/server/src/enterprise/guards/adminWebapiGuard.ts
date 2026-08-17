/**
 * Reusable admin webapi auth stack (design §5).
 *
 * checkAuth (caller) → active-user → platform permission → recent reauth (dangerous)
 * → admin mutation rate limit. Reauth reads the same Better Auth session.createdAt /
 * OIDC auth_time sources as tRPC (`createLambdaContext`).
 */
import { auth } from '@/auth';
import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformPermission } from '@/const/platform/permissions';
import type { LobeChatDatabase } from '@/database/type';
import { LOBE_CHAT_OIDC_AUTH_HEADER } from '@/envs/auth';
import { assertUserActive, isOIDCUserInactiveError } from '@/libs/oidc-provider/access-control';
import { validateOIDCJWT } from '@/libs/oidc-provider/jwt';
import type { AuthMethod } from '@/libs/trpc/lambda/context';
import {
  extractOidcAuthenticatedAt,
  extractOidcCredentialIssuedAt,
} from '@/libs/trpc/lambda/context';

import { isPlatformAdminFeatureEnabled } from '../featureFlags';
import { getSharedAdminMutationRateLimiter } from '../security/rateLimit/adminMutationRateLimiter';
import type { AuditAction, AuditTargetType } from '../services/audit/auditActionCatalog';
import { throwEnterpriseError } from './enterpriseErrors';
import { loadPlatformAuthContext } from './platformPermission';
import { assertDangerousReauthWithAudit } from './reauth';

export interface AdminWebapiHandlerContext {
  authenticatedAt: Date | null;
  authMethod: AuthMethod | null;
  credentialIssuedAt: Date | null;
  serverDB: LobeChatDatabase;
  sessionId: string | null;
  userId: string;
}

export type AdminWebapiHandler = (
  req: Request,
  ctx: AdminWebapiHandlerContext,
) => Promise<Response>;

export interface AdminWebapiGuardOptions {
  dangerous?: boolean;
  /**
   * Audit descriptor written when a dangerous call is denied for stale reauth.
   * Required when `dangerous` is true.
   */
  denied?: {
    action: AuditAction;
    targetId?: string | null;
    targetType: AuditTargetType;
  };
  permission: PlatformPermission;
  /** Canonical `admin.*` procedure path consumed by the shared mutation limiter. */
  procedure: `admin.${string}`;
}

export interface CheckAuthContext {
  serverDB: LobeChatDatabase;
  userId: string;
}

const jsonError = (code: string, status: number) => Response.json({ code }, { status });

const statusForEnterpriseCode = (code: string): number => {
  if (code === ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED) return 401;
  if (code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED) return 401;
  if (code === ADMIN_ERROR_CODES.ADMIN_RATE_LIMITED) return 429;
  if (code === ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED) return 403;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED) return 403;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT) return 409;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND) return 404;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT) return 400;
  return 400;
};

export const adminWebapiErrorResponse = (error: unknown): Response => {
  if (error instanceof Response) return error;
  if (error && typeof error === 'object') {
    const cause = (error as { cause?: { data?: { code?: string } } }).cause;
    const code = cause?.data?.code;
    if (typeof code === 'string' && code.length > 0) {
      return jsonError(code, statusForEnterpriseCode(code));
    }
    const trpcCode = (error as { message?: string }).message;
    if (
      typeof trpcCode === 'string' &&
      trpcCode in { ...ADMIN_ERROR_CODES, ...PLATFORM_ERROR_CODES }
    ) {
      return jsonError(trpcCode, statusForEnterpriseCode(trpcCode));
    }
  }
  return jsonError(PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED, 500);
};

/**
 * Resolve interactive reauth + security-epoch timestamps from the same cookies /
 * OIDC header tRPC uses. API-key callers never satisfy recent reauth.
 */
export const resolveAdminWebapiAuthSignals = async (
  req: Request,
): Promise<{
  authMethod: AuthMethod | null;
  authenticatedAt: Date | null;
  credentialIssuedAt: Date | null;
  sessionId: string | null;
}> => {
  const oidcAuthorization = req.headers.get(LOBE_CHAT_OIDC_AUTH_HEADER);
  if (oidcAuthorization) {
    try {
      const oidc = await validateOIDCJWT(oidcAuthorization);
      const tokenData = oidc.tokenData as Record<string, unknown>;
      return {
        authMethod: 'oidc',
        authenticatedAt: extractOidcAuthenticatedAt(tokenData),
        credentialIssuedAt: extractOidcCredentialIssuedAt(tokenData),
        sessionId: null,
      };
    } catch {
      return {
        authMethod: 'oidc',
        authenticatedAt: null,
        credentialIssuedAt: null,
        sessionId: null,
      };
    }
  }

  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (session?.user?.id) {
      const rawCreatedAt = session.session?.createdAt;
      const sessionCreatedAt =
        rawCreatedAt instanceof Date ? rawCreatedAt : rawCreatedAt ? new Date(rawCreatedAt) : null;
      const issuedAt =
        sessionCreatedAt && !Number.isNaN(sessionCreatedAt.getTime()) ? sessionCreatedAt : null;
      const sessionId = typeof session.session?.id === 'string' ? session.session.id : null;
      return {
        authMethod: 'better-auth',
        authenticatedAt: issuedAt,
        credentialIssuedAt: issuedAt,
        sessionId,
      };
    }
  } catch {
    // Fall through — checkAuth already accepted the principal.
  }

  return { authMethod: null, authenticatedAt: null, credentialIssuedAt: null, sessionId: null };
};

const auditPermissionDenied = async (params: {
  actorUserId: string;
  db: LobeChatDatabase;
  path: string;
  permission: string;
}) => {
  try {
    const { PlatformAuditLogModel } = await import('@/database/models/platform');
    await new PlatformAuditLogModel(params.db).append({
      action: 'admin.permission.denied',
      actorUserId: params.actorUserId,
      afterDiff: {
        error: 'permission_denied',
        path: params.path,
        permission: params.permission,
      },
      result: 'denied',
      targetType: 'permission',
    });
  } catch {
    console.error('[platform-audit] permission denied append failed', {
      permission: params.permission,
    });
  }
};

/**
 * Inner guard after `checkAuth` has established `userId` + `serverDB`.
 */
export const withAdminWebapiGuard =
  (options: AdminWebapiGuardOptions) =>
  (handler: AdminWebapiHandler) =>
  async (req: Request, authCtx: CheckAuthContext): Promise<Response> => {
    try {
      if (!isPlatformAdminFeatureEnabled()) {
        return throwEnterpriseError({
          code: ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED,
          httpCode: 'FORBIDDEN',
        });
      }

      const signals = await resolveAdminWebapiAuthSignals(req);

      if (isPlatformAdminFeatureEnabled()) {
        try {
          await assertUserActive(authCtx.serverDB, authCtx.userId, {
            credentialIssuedAt: signals.credentialIssuedAt,
            sessionId: signals.sessionId,
          });
        } catch (error) {
          if (isOIDCUserInactiveError(error)) {
            return throwEnterpriseError({
              code: ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED,
              details: { reason: 'user_inactive' },
              httpCode: 'UNAUTHORIZED',
            });
          }
          throw error;
        }
      }

      const platformAuth = await loadPlatformAuthContext({
        db: authCtx.serverDB,
        userId: authCtx.userId,
      });
      if (!platformAuth.permissions.includes(options.permission)) {
        await auditPermissionDenied({
          actorUserId: authCtx.userId,
          db: authCtx.serverDB,
          path: options.procedure,
          permission: options.permission,
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
          details: { permission: options.permission },
          httpCode: 'FORBIDDEN',
        });
      }

      if (options.dangerous) {
        if (!options.denied) {
          throw new TypeError('withAdminWebapiGuard dangerous=true requires a denied descriptor');
        }
        await assertDangerousReauthWithAudit({
          authenticatedAt: signals.authenticatedAt,
          authMethod: signals.authMethod,
          denied: {
            action: options.denied.action,
            actorUserId: authCtx.userId,
            targetId: options.denied.targetId ?? null,
            targetType: options.denied.targetType,
          },
          serverDB: authCtx.serverDB,
        });
      }

      const decision = await getSharedAdminMutationRateLimiter().consume({
        actorId: authCtx.userId,
        db: authCtx.serverDB,
        procedure: options.procedure,
      });
      if (decision !== 'allowed') {
        return throwEnterpriseError({
          code: ADMIN_ERROR_CODES.ADMIN_RATE_LIMITED,
          httpCode: 'TOO_MANY_REQUESTS',
        });
      }

      return await handler(req, {
        authMethod: signals.authMethod,
        authenticatedAt: signals.authenticatedAt,
        credentialIssuedAt: signals.credentialIssuedAt,
        serverDB: authCtx.serverDB,
        sessionId: signals.sessionId,
        userId: authCtx.userId,
      });
    } catch (error) {
      return adminWebapiErrorResponse(error);
    }
  };
