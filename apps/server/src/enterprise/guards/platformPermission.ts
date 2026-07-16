import {
  ADMIN_ERROR_CODES,
  type EnterpriseErrorCode,
  PLATFORM_ERROR_CODES,
} from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';
import { trpc } from '@/libs/trpc/lambda/init';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { isPlatformAdminFeatureEnabled } from '../featureFlags';
import { throwEnterpriseError } from './enterpriseErrors';

export interface PlatformAuthContext {
  actorId: string;
  permissions: string[];
  requestId?: string;
}

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
 * Load global platform permissions for the authenticated principal.
 * Empty when enterprise admin flag is off (callers should feature-gate).
 */
export const loadPlatformAuthContext = async (params: {
  db: LobeChatDatabase;
  requestId?: string;
  userId: string;
}): Promise<PlatformAuthContext> => {
  const rbac = new RbacModel(params.db, params.userId);
  const permissions = await rbac.getGlobalUserPermissions(params.userId);
  return {
    actorId: params.userId,
    permissions,
    requestId: params.requestId,
  };
};

export const assertPlatformPermission = (
  auth: PlatformAuthContext,
  code: string,
  deniedCode: EnterpriseErrorCode = PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
): void => {
  if (!auth.permissions.includes(code)) {
    throwEnterpriseError({
      code: deniedCode,
      details: { permission: code },
      httpCode: 'FORBIDDEN',
      message: deniedCode,
    });
  }
};

export const assertAnyPlatformPermission = (
  auth: PlatformAuthContext,
  codes: string[],
  deniedCode: EnterpriseErrorCode = PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
): void => {
  if (!codes.some((code) => auth.permissions.includes(code))) {
    throwEnterpriseError({
      code: deniedCode,
      details: { permission: codes.join('|') },
      httpCode: 'FORBIDDEN',
      message: deniedCode,
    });
  }
};

/**
 * tRPC middleware: require a single platform permission on a global role.
 * Flag-gated: when ENABLE_PLATFORM_ADMIN is off → ADMIN_FEATURE_DISABLED.
 */
export const withPlatformPermission = (code: string) =>
  trpc.middleware(async ({ ctx, next }) => {
    const rawUserId = ctx.userId;
    if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
      return throwEnterpriseError({
        code: ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED,
        httpCode: 'UNAUTHORIZED',
        message: 'UNAUTHORIZED',
      });
    }

    if (!isPlatformAdminFeatureEnabled()) {
      return throwEnterpriseError({
        code: ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED,
        httpCode: 'FORBIDDEN',
      });
    }

    const db = resolveServerDb(ctx as { serverDB?: LobeChatDatabase });
    const platformAuth = await loadPlatformAuthContext({
      db,
      userId: rawUserId,
    });
    assertPlatformPermission(platformAuth, code);

    return next({
      ctx: {
        platformAuth,
      },
    });
  });

export const withAnyPlatformPermission = (codes: string[]) =>
  trpc.middleware(async ({ ctx, next }) => {
    const rawUserId = ctx.userId;
    if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
      return throwEnterpriseError({
        code: ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED,
        httpCode: 'UNAUTHORIZED',
        message: 'UNAUTHORIZED',
      });
    }

    if (!isPlatformAdminFeatureEnabled()) {
      return throwEnterpriseError({
        code: ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED,
        httpCode: 'FORBIDDEN',
      });
    }

    const db = resolveServerDb(ctx as { serverDB?: LobeChatDatabase });
    const platformAuth = await loadPlatformAuthContext({
      db,
      userId: rawUserId,
    });
    assertAnyPlatformPermission(platformAuth, codes);

    return next({
      ctx: {
        platformAuth,
      },
    });
  });

/**
 * Admin procedure base: authed + serverDB. Permission middleware is composed per-route.
 */
export { serverDatabase };

/** Convenience: ADMIN_ACCESS gate for menu shell. */
export const withAdminAccess = () => withPlatformPermission(PLATFORM_PERMISSIONS.ADMIN_ACCESS);
