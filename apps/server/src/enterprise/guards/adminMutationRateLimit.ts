/**
 * tRPC middleware: multi-instance administrative mutation rate limit.
 * Queries skip enforcement (and must not consume quota).
 */
import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';
import { trpc } from '@/libs/trpc/lambda/init';

import {
  type AdminMutationRateLimiter,
  getSharedAdminMutationRateLimiter,
} from '../security/rateLimit/adminMutationRateLimiter';
import { throwEnterpriseError } from './enterpriseErrors';

export interface AdminMutationRateLimitMetadata {
  enforced: true;
  kind: 'admin-mutation-rate-limit';
}

interface TrpcProcedureWithMiddleware {
  _def?: {
    middlewares?: readonly unknown[];
  };
}

const ADMIN_MUTATION_RATE_LIMIT_METADATA = Symbol('adminMutationRateLimitMetadata');

const RATE_LIMIT_METADATA: AdminMutationRateLimitMetadata = Object.freeze({
  enforced: true,
  kind: 'admin-mutation-rate-limit',
});

const attachAdminMutationRateLimitMetadata = (middleware: unknown): void => {
  if (typeof middleware !== 'function') {
    throw new TypeError('Admin mutation rate-limit middleware must be a function');
  }
  Object.defineProperty(middleware, ADMIN_MUTATION_RATE_LIMIT_METADATA, {
    configurable: false,
    enumerable: false,
    value: RATE_LIMIT_METADATA,
    writable: false,
  });
};

/**
 * Read private rate-limit metadata from the actual final middleware chain.
 * The Symbol property is non-enumerable so it cannot become API output.
 */
export const getAdminMutationRateLimitMetadata = (
  procedure: unknown,
): readonly AdminMutationRateLimitMetadata[] => {
  if (typeof procedure !== 'function') return [];

  const middlewares = (procedure as TrpcProcedureWithMiddleware)._def?.middlewares;
  if (!Array.isArray(middlewares)) return [];

  return middlewares.flatMap((middleware) => {
    if (typeof middleware !== 'function') return [];
    const descriptor = Object.getOwnPropertyDescriptor(
      middleware,
      ADMIN_MUTATION_RATE_LIMIT_METADATA,
    );
    if (!descriptor) return [];
    return [descriptor.value as AdminMutationRateLimitMetadata];
  });
};

const toCanonicalAdminProcedure = (path: string | undefined): string | null => {
  if (typeof path !== 'string' || path.length === 0) return null;
  return path.startsWith('admin.') ? path : `admin.${path}`;
};

const denyRateLimited = (): never =>
  throwEnterpriseError({
    code: ADMIN_ERROR_CODES.ADMIN_RATE_LIMITED,
    httpCode: 'TOO_MANY_REQUESTS',
    message: ADMIN_ERROR_CODES.ADMIN_RATE_LIMITED,
  });

/**
 * Enforce the shared admin mutation rate limit.
 * Attach to every live admin mutation middleware chain (bases may also host queries;
 * query traffic is skipped and does not consume quota).
 */
export const withAdminMutationRateLimit = (options?: {
  getLimiter?: () => AdminMutationRateLimiter;
}) => {
  const getLimiter = options?.getLimiter ?? getSharedAdminMutationRateLimiter;

  const middleware = trpc.middleware(async ({ ctx, next, path, type }) => {
    if (type !== 'mutation') {
      return next();
    }

    const actorId = ctx.userId;
    if (typeof actorId !== 'string' || actorId.length === 0) {
      return throwEnterpriseError({
        code: ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED,
        httpCode: 'UNAUTHORIZED',
        message: 'UNAUTHORIZED',
      });
    }

    const procedure = toCanonicalAdminProcedure(path);
    if (!procedure) {
      return denyRateLimited();
    }

    const decision = await getLimiter().consume({ actorId, procedure });
    if (decision !== 'allowed') {
      return denyRateLimited();
    }

    return next();
  });

  attachAdminMutationRateLimitMetadata(middleware._middlewares.at(-1));
  return middleware;
};
