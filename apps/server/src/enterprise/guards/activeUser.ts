/**
 * Shared active-user guard for critical admin procedures (M04).
 * Ensures createContextInner({ userId }) callers cannot bypass ban/invalidation
 * when platform admin is enabled. Flag-off: no-op (upstream parity).
 *
 * R2-02: ban/security-cutoff uses credentialIssuedAt only — never authenticatedAt/auth_time.
 */
import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { LobeChatDatabase } from '@/database/type';
import { assertUserActive, isOIDCUserInactiveError } from '@/libs/oidc-provider/access-control';
import { trpc } from '@/libs/trpc/lambda/init';

import { getEnterpriseFeatureFlags, isPlatformAdminFeatureEnabled } from '../featureFlags';
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

export interface WithActiveUserOptions {
  /**
   * Force active-user enforcement even when ENABLE_PLATFORM_ADMIN is off.
   *
   * Set for user-facing enterprise routers (e.g. platform.agents) whose surface
   * can be enabled independently via ENABLE_PLATFORM_MANAGED_* flags — otherwise an
   * inactive/banned/epoch-invalid principal could read Effective data when only the
   * managed-agents flag is on. Defaults false to keep upstream-parity no-op for
   * admin-only routers (which are unreachable while the admin flag is off).
   */
  enforceWhenAdminDisabled?: boolean;
}

/** tRPC ctx fields the active-user assertion trusts. */
interface ActiveUserCtx {
  authMethod?: string;
  credentialIssuedAt?: Date;
  sessionId?: string;
  userId?: string;
}

/**
 * Reject an effectively banned / auth-invalidated principal, using only the trusted security-epoch
 * timestamp (never authenticatedAt/auth_time). Throws UNAUTHORIZED. Shared by every active-user
 * guard so the enforcement is identical regardless of which flag gates it.
 */
const enforceActiveUser = async (ctx: ActiveUserCtx & { serverDB?: LobeChatDatabase }) => {
  const rawUserId = ctx.userId;
  if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
    return throwEnterpriseError({
      code: ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED,
      httpCode: 'UNAUTHORIZED',
    });
  }

  const db = resolveServerDb(ctx);
  // Trusted security-epoch timestamp only (session issuance / OIDC iat / API-key createdAt).
  const credentialIssuedAt =
    ctx.credentialIssuedAt instanceof Date && !Number.isNaN(ctx.credentialIssuedAt.getTime())
      ? ctx.credentialIssuedAt
      : null;
  // Session exception only for Better Auth path with trusted sessionId (never OIDC/API-key).
  const sessionId =
    ctx.authMethod === 'better-auth' && typeof ctx.sessionId === 'string' ? ctx.sessionId : null;

  try {
    await assertUserActive(db, rawUserId, { credentialIssuedAt, sessionId });
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
 * Reject effectively banned / auth-invalidated principals on procedure entry.
 * No-op when ENABLE_PLATFORM_ADMIN is off, unless `enforceWhenAdminDisabled` is set.
 */
export const withActiveUser = (options: WithActiveUserOptions = {}) =>
  trpc.middleware(async ({ ctx, next }) => {
    if (!options.enforceWhenAdminDisabled && !isPlatformAdminFeatureEnabled()) {
      return next();
    }
    await enforceActiveUser(ctx as ActiveUserCtx & { serverDB?: LobeChatDatabase });
    return next();
  });

/**
 * Active-user guard for ordinary user entrypoints that gain a managed-Agent surface under M10
 * (unified list, platform chat runtime). The extra restriction exists ONLY because of the managed
 * surface, so it is gated strictly on that surface being enabled:
 *
 * - `ENABLE_PLATFORM_MANAGED_AGENTS` OFF → no-op, so the legacy local-only behavior and its access
 *   rules are preserved verbatim (no new restriction). This holds even when `ENABLE_PLATFORM_ADMIN`
 *   is ON (RR2-7): the admin flag alone must not add a ban/epoch restriction to these ordinary
 *   legacy entrypoints — admin-only routers enforce their own `withActiveUser` separately. A
 *   `MANAGED=0 + ADMIN=1` caller therefore keeps full legacy pass-through here (banned/inactive/
 *   epoch-invalid principals are served exactly as upstream), with zero platform access.
 * - `ENABLE_PLATFORM_MANAGED_AGENTS` ON → reject banned / inactive / epoch-invalid principals BEFORE
 *   any platform resolver / catalog / materialization access (ADMIN independent). Reuses the exact
 *   same `enforceActiveUser` assertion as the admin guard.
 */
export const withActiveUserWhenManagedAgents = () =>
  trpc.middleware(async ({ ctx, next }) => {
    const flags = getEnterpriseFeatureFlags();
    if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) {
      return next();
    }
    await enforceActiveUser(ctx as ActiveUserCtx & { serverDB?: LobeChatDatabase });
    return next();
  });
