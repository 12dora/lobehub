/**
 * Active-user guard for user-facing managed-resource surfaces (Connectors, Skills, AI).
 * Enforces only when the corresponding ENABLE_PLATFORM_MANAGED_* flag is on, matching
 * withActiveUserWhenManagedAgents — so flag-off preserves legacy pass-through.
 */
import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import type { LobeChatDatabase } from '@/database/type';
import { assertUserActive, isOIDCUserInactiveError } from '@/libs/oidc-provider/access-control';
import { trpc } from '@/libs/trpc/lambda/init';

import { getEnterpriseFeatureFlags } from '../featureFlags';
import { throwEnterpriseError } from '../guards/enterpriseErrors';

type ManagedSurfaceFlag = keyof Pick<
  EnterpriseFeatureFlags,
  | 'ENABLE_PLATFORM_MANAGED_AI'
  | 'ENABLE_PLATFORM_MANAGED_CONNECTORS'
  | 'ENABLE_PLATFORM_MANAGED_SKILLS'
>;

interface ActiveUserCtx {
  authMethod?: string;
  credentialIssuedAt?: Date;
  serverDB?: LobeChatDatabase;
  sessionId?: string;
  userId?: string;
}

const enforceActiveUser = async (ctx: ActiveUserCtx) => {
  const rawUserId = ctx.userId;
  if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
    return throwEnterpriseError({
      code: ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED,
      httpCode: 'UNAUTHORIZED',
    });
  }
  if (!ctx.serverDB) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      message: 'serverDB missing — apply serverDatabase middleware first',
    });
  }

  const credentialIssuedAt =
    ctx.credentialIssuedAt instanceof Date && !Number.isNaN(ctx.credentialIssuedAt.getTime())
      ? ctx.credentialIssuedAt
      : null;
  const sessionId =
    ctx.authMethod === 'better-auth' && typeof ctx.sessionId === 'string' ? ctx.sessionId : null;

  try {
    await assertUserActive(ctx.serverDB, rawUserId, { credentialIssuedAt, sessionId });
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
};

/**
 * Reject banned / temporarily banned / epoch-invalid principals before managed-resource
 * catalog or OAuth access, only while the named managed-surface flag is enabled.
 */
export const withActiveUserWhenManaged = (flag: ManagedSurfaceFlag) =>
  trpc.middleware(async ({ ctx, next }) => {
    if (!getEnterpriseFeatureFlags()[flag]) {
      return next();
    }
    await enforceActiveUser(ctx as ActiveUserCtx);
    return next();
  });
