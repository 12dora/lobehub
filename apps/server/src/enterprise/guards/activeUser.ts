/**
 * Shared active-user guard for critical admin procedures (M04).
 * Ensures createContextInner({ userId }) callers cannot bypass ban/invalidation
 * when platform admin is enabled. Flag-off: no-op (upstream parity).
 */
import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { LobeChatDatabase } from '@/database/type';
import { assertUserActive, isOIDCUserInactiveError } from '@/libs/oidc-provider/access-control';
import { trpc } from '@/libs/trpc/lambda/init';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { isPlatformAdminFeatureEnabled } from '../featureFlags';
import { throwEnterpriseError } from './enterpriseErrors';

const resolveServerDb = (ctx: { serverDB?: LobeChatDatabase }): LobeChatDatabase => {
  if (!ctx.serverDB) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      message: 'serverDB missing — apply serverDatabase middleware first',
    });
  }
  return ctx.serverDB as LobeChatDatabase;
};

/**
 * Reject effectively banned / auth-invalidated principals on admin procedure entry.
 * No-op when ENABLE_PLATFORM_ADMIN is off.
 */
export const withActiveUser = () =>
  trpc.middleware(async ({ ctx, next }) => {
    if (!isPlatformAdminFeatureEnabled()) {
      return next();
    }

    const rawUserId = ctx.userId;
    if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
      return throwEnterpriseError({
        code: ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED,
        httpCode: 'UNAUTHORIZED',
      });
    }

    const db = resolveServerDb(ctx as { serverDB?: LobeChatDatabase });
    const credentialIssuedAt =
      ctx.authenticatedAt instanceof Date
        ? ctx.authenticatedAt
        : ctx.authMethod === 'api-key'
          ? null
          : (ctx.authenticatedAt ?? null);

    try {
      await assertUserActive(db, rawUserId, {
        // For BA/OIDC, authenticatedAt is session createdAt / auth_time — usable as lower bound.
        // API keys: null credential time fails closed when authInvalidatedAt is set.
        credentialIssuedAt:
          ctx.authMethod === 'api-key' ? null : (credentialIssuedAt as Date | null),
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

    return next();
  });

/** Admin base: authed + serverDB + active user (when platform admin on). */
export const adminProcedureBase = () => serverDatabase; // composed at call sites
