import {
  ADMIN_ERROR_CODES,
  type EnterpriseErrorCode,
  PLATFORM_ERROR_CODES,
} from '@/const/platform/errorCodes';
import { MODULE_BY_ADMIN_ROUTER_KEY } from '@/const/platform/modules';
import { type PlatformPermission } from '@/const/platform/permissions';
import { RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';
import { trpc } from '@/libs/trpc/lambda/init';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { isPlatformAdminFeatureEnabled } from '../featureFlags';
import { assertModuleEnabled } from '../services/moduleSettings';
import { throwEnterpriseError } from './enterpriseErrors';

export interface PlatformAuthContext {
  actorId: string;
  permissions: string[];
  requestId?: string;
}

/**
 * - `all` — every listed permission required
 * - `any` — at least one listed permission required
 * - `compound` — every entry in `permissions` plus one input-selected entry from
 *   `selectable` (see {@link withCompoundPlatformPermission})
 */
export type PlatformPermissionMode = 'all' | 'any' | 'compound';

export interface PlatformPermissionMetadata {
  mode: PlatformPermissionMode;
  permissions: readonly PlatformPermission[];
  /**
   * For `mode: 'compound'`: the input-selected secondary permission is one of these.
   * Required together with every entry in `permissions`.
   */
  selectable?: readonly PlatformPermission[];
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
      ...(metadata.selectable ? { selectable: Object.freeze([...metadata.selectable]) } : {}),
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

const platformAuthContextByScope = new WeakMap<object, Promise<PlatformAuthContext>>();

/**
 * tRPC middleware `next({ ctx })` spreads a new object per hop. The request
 * `resHeaders` Headers instance is created once in createContextInner and
 * survives the spread, so it is a stable per-HTTP-request identity.
 */
const requestScopeOf = (scope: object): object => {
  if ('resHeaders' in scope && scope.resHeaders && typeof scope.resHeaders === 'object') {
    return scope.resHeaders;
  }
  return scope;
};

const loadPlatformAuthContextUncached = async (params: {
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

/**
 * Load global platform permissions for the authenticated principal.
 * Empty when enterprise admin flag is off (callers should feature-gate).
 *
 * Pass `scope` (typically the tRPC `ctx` object) to memoize the 4-table RBAC
 * join for the rest of the HTTP request — admin overview batches the same
 * join ~10× otherwise.
 */
export const loadPlatformAuthContext = async (params: {
  db: LobeChatDatabase;
  requestId?: string;
  scope?: object;
  userId: string;
}): Promise<PlatformAuthContext> => {
  if (!params.scope) return loadPlatformAuthContextUncached(params);

  const key = requestScopeOf(params.scope);
  const cached = platformAuthContextByScope.get(key);
  if (cached) return cached;

  const pending = loadPlatformAuthContextUncached(params);
  platformAuthContextByScope.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    platformAuthContextByScope.delete(key);
    throw error;
  }
};

/** Resolve `admin.audit.list` → `audit` (or `audit.list` → `audit`). */
export const adminRouterKeyFromPath = (path: string): string => {
  const parts = path.split('.');
  return parts[1] ?? parts[0] ?? path;
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

const denyPermission = async (params: {
  actorUserId: string;
  db: LobeChatDatabase;
  path?: string;
  permission: string;
}): Promise<never> => {
  await auditPermissionDenied(params);
  return throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
    details: { permission: params.permission },
    httpCode: 'FORBIDDEN',
    message: PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
  });
};

type PermissionPredicate = (params: {
  getRawInput: () => Promise<unknown>;
  platformAuth: PlatformAuthContext;
}) => Promise<{ deniedPermission: string } | { ok: true }>;

/**
 * Single implementation for platform permission middleware constructors.
 * Owns actor validation, feature gate, auth context load, denial audit, and metadata.
 */
const withPlatformPermissions = (params: {
  metadata: PlatformPermissionMetadata;
  predicate: PermissionPredicate;
}) => {
  const middleware = trpc.middleware(async ({ ctx, getRawInput, next, path }) => {
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

    const moduleId = MODULE_BY_ADMIN_ROUTER_KEY[adminRouterKeyFromPath(path)];
    if (moduleId) await assertModuleEnabled(moduleId);

    const db = resolveServerDb(ctx as { serverDB?: LobeChatDatabase });
    const platformAuth = await loadPlatformAuthContext({
      db,
      scope: ctx,
      userId: rawUserId,
    });

    const result = await params.predicate({ getRawInput, platformAuth });
    if (!('ok' in result)) {
      return denyPermission({
        actorUserId: rawUserId,
        db,
        path,
        permission: result.deniedPermission,
      });
    }

    return next({
      ctx: {
        platformAuth,
      },
    });
  });

  attachPlatformPermissionMetadata(middleware._middlewares.at(-1), params.metadata);
  return middleware;
};

/**
 * tRPC middleware: require a single platform permission on a global role.
 * Flag-gated: when ENABLE_PLATFORM_ADMIN is off → ADMIN_FEATURE_DISABLED.
 */
export const withPlatformPermission = (code: PlatformPermission) =>
  withPlatformPermissions({
    metadata: { mode: 'all', permissions: [code] },
    predicate: async ({ platformAuth }) =>
      platformAuth.permissions.includes(code) ? { ok: true } : { deniedPermission: code },
  });

/**
 * tRPC middleware: require every listed platform permission (mode: all).
 * Prefer this over stacking `withPlatformPermission` — reconcile expects exactly one gate.
 */
export const withAllPlatformPermissions = (codes: readonly PlatformPermission[]) =>
  withPlatformPermissions({
    metadata: { mode: 'all', permissions: codes },
    predicate: async ({ platformAuth }) => {
      const missing = codes.find((code) => !platformAuth.permissions.includes(code));
      return missing ? { deniedPermission: missing } : { ok: true };
    },
  });

export interface CompoundPlatformPermissionOptions {
  /**
   * Permissions always required (typically `*_PUBLISH`).
   * Checked first; the first missing one is the denial detail.
   */
  fixed: readonly PlatformPermission[];
  /**
   * Select the secondary operation permission from the already-parsed procedure input.
   * Invoked only after fixed permissions pass.
   */
  select: (input: unknown) => PlatformPermission;
  /**
   * Closed set of permissions `select` may return — stored in authorization metadata.
   */
  selectable: readonly PlatformPermission[];
}

/**
 * Input-aware compound gate: requires every `fixed` permission plus one
 * input-selected secondary permission. Both denials emit `admin.permission.denied`.
 *
 * Used by applyImmediate surfaces (AI providers/models, connectors, skills) where
 * PUBLISH is always required and CREATE/UPDATE/DELETE depends on the mutation mode.
 */
export const withCompoundPlatformPermission = (options: CompoundPlatformPermissionOptions) => {
  if (options.fixed.length === 0) {
    throw new TypeError('withCompoundPlatformPermission requires at least one fixed permission');
  }
  if (options.selectable.length === 0) {
    throw new TypeError('withCompoundPlatformPermission requires a non-empty selectable set');
  }

  return withPlatformPermissions({
    metadata: {
      mode: 'compound',
      permissions: options.fixed,
      selectable: options.selectable,
    },
    predicate: async ({ getRawInput, platformAuth }) => {
      const missingFixed = options.fixed.find((code) => !platformAuth.permissions.includes(code));
      if (missingFixed) return { deniedPermission: missingFixed };

      const input = await getRawInput();
      const selected = options.select(input);
      if (!options.selectable.includes(selected)) {
        // Closed set: a selector bug must not expand the authorization surface.
        return { deniedPermission: selected };
      }
      if (!platformAuth.permissions.includes(selected)) {
        return { deniedPermission: selected };
      }
      return { ok: true };
    },
  });
};

/**
 * Admin procedure base: authed + serverDB. Permission middleware is composed per-route.
 */
export { serverDatabase };
