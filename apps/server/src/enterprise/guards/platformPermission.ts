import {
  ADMIN_ERROR_CODES,
  type EnterpriseErrorCode,
  PLATFORM_ERROR_CODES,
} from '@/const/platform/errorCodes';
import { type PlatformPermission } from '@/const/platform/permissions';
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

export type PlatformPermissionMode = 'all' | 'any';

export interface PlatformPermissionMetadata {
  mode: PlatformPermissionMode;
  permissions: readonly PlatformPermission[];
}

interface TrpcProcedureWithMiddleware {
  _def?: {
    middlewares?: readonly unknown[];
  };
}

const PLATFORM_PERMISSION_METADATA = Symbol('platformPermissionMetadata');

const attachPlatformPermissionMetadata = (
  middleware: unknown,
  metadata: PlatformPermissionMetadata,
): void => {
  if (typeof middleware !== 'function') {
    throw new TypeError('Platform permission middleware must be a function');
  }

  Object.defineProperty(middleware, PLATFORM_PERMISSION_METADATA, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      mode: metadata.mode,
      permissions: Object.freeze([...metadata.permissions]),
    }),
    writable: false,
  });
};

/**
 * Read server-only authorization metadata from the actual middleware chain of a final procedure.
 * The Symbol property is deliberately private and non-enumerable, so it cannot become API output.
 */
export const getPlatformPermissionMetadata = (
  procedure: unknown,
): readonly PlatformPermissionMetadata[] => {
  if (typeof procedure !== 'function') return [];

  const middlewares = (procedure as TrpcProcedureWithMiddleware)._def?.middlewares;
  if (!Array.isArray(middlewares)) return [];

  return middlewares.flatMap((middleware) => {
    if (typeof middleware !== 'function') return [];
    const descriptor = Object.getOwnPropertyDescriptor(middleware, PLATFORM_PERMISSION_METADATA);
    if (!descriptor) return [];
    return [descriptor.value as PlatformPermissionMetadata];
  });
};

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

/**
 * tRPC middleware: require a single platform permission on a global role.
 * Flag-gated: when ENABLE_PLATFORM_ADMIN is off → ADMIN_FEATURE_DISABLED.
 */
/** Sanitized permission-denied audit (R2-03) — never logs raw input or secrets. */
const auditPermissionDenied = async (params: {
  actorUserId: string;
  db: LobeChatDatabase;
  path?: string;
  permission: string;
}) => {
  try {
    const { PlatformAuditLogModel } = await import('@/database/models/platform');
    await new PlatformAuditLogModel(params.db).append({
      action: 'admin.permission.denied',
      actorUserId: params.actorUserId,
      afterDiff: {
        error: 'permission_denied',
        path: params.path ?? null,
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

export const withPlatformPermission = (code: PlatformPermission) => {
  const middleware = trpc.middleware(async ({ ctx, next, path }) => {
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
    if (!platformAuth.permissions.includes(code)) {
      await auditPermissionDenied({
        actorUserId: rawUserId,
        db,
        path,
        permission: code,
      });
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
        details: { permission: code },
        httpCode: 'FORBIDDEN',
        message: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      });
    }

    return next({
      ctx: {
        platformAuth,
      },
    });
  });

  attachPlatformPermissionMetadata(middleware._middlewares.at(-1), {
    mode: 'all',
    permissions: [code],
  });
  return middleware;
};

export const withAnyPlatformPermission = (codes: readonly PlatformPermission[]) => {
  const middleware = trpc.middleware(async ({ ctx, next, path }) => {
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
    if (!codes.some((code) => platformAuth.permissions.includes(code))) {
      await auditPermissionDenied({
        actorUserId: rawUserId,
        db,
        path,
        permission: codes.join('|'),
      });
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
        details: { permission: codes.join('|') },
        httpCode: 'FORBIDDEN',
        message: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      });
    }

    return next({
      ctx: {
        platformAuth,
      },
    });
  });

  attachPlatformPermissionMetadata(middleware._middlewares.at(-1), {
    mode: 'any',
    permissions: codes,
  });
  return middleware;
};

/**
 * tRPC middleware: require every listed platform permission (mode: all).
 * Prefer this over stacking `withPlatformPermission` — reconcile expects exactly one gate.
 */
export const withAllPlatformPermissions = (codes: readonly PlatformPermission[]) => {
  const middleware = trpc.middleware(async ({ ctx, next, path }) => {
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
    const missing = codes.find((code) => !platformAuth.permissions.includes(code));
    if (missing) {
      await auditPermissionDenied({
        actorUserId: rawUserId,
        db,
        path,
        permission: missing,
      });
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
        details: { permission: missing },
        httpCode: 'FORBIDDEN',
        message: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      });
    }

    return next({
      ctx: {
        platformAuth,
      },
    });
  });

  attachPlatformPermissionMetadata(middleware._middlewares.at(-1), {
    mode: 'all',
    permissions: codes,
  });
  return middleware;
};

/**
 * Admin procedure base: authed + serverDB. Permission middleware is composed per-route.
 */
export { serverDatabase };
