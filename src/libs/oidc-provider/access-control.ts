import type { LobeChatDatabase } from '@lobechat/database';
import {
  oidcAccessTokens,
  oidcAuthorizationCodes,
  oidcDeviceCodes,
  oidcGrants,
  oidcRefreshTokens,
  oidcSessions,
  session,
  users,
} from '@lobechat/database/schemas';
import { and, eq, gt } from 'drizzle-orm';

import {
  type CredentialInvalidationCheck,
  isCredentialInvalidated,
  isEffectivelyBanned,
} from '@/database/utils/userBan';

export const OIDC_USER_INACTIVE_ERROR_MESSAGE = 'OIDC user is no longer active';

export class OIDCUserInactiveError extends Error {
  readonly code = 'UNAUTHORIZED';

  constructor() {
    super(OIDC_USER_INACTIVE_ERROR_MESSAGE);
    this.name = 'OIDCUserInactiveError';
  }
}

export const isOIDCUserInactiveError = (error: unknown) => error instanceof OIDCUserInactiveError;

/** @deprecated Prefer isEffectivelyBanned from @lobechat/database/utils/userBan */
export const isOIDCUserBanned = (
  user: { banExpires: Date | null; banned: boolean | null },
  now = new Date(),
) => isEffectivelyBanned(user, now);

const OIDC_USER_ARTIFACT_TABLES = [
  oidcAccessTokens,
  oidcAuthorizationCodes,
  oidcRefreshTokens,
  oidcDeviceCodes,
  oidcGrants,
  oidcSessions,
] as const;

type OIDCUserArtifactTable = (typeof OIDC_USER_ARTIFACT_TABLES)[number];

/**
 * Revokes database-backed OIDC artifacts for a user.
 *
 * JWT access tokens are stateless and remain valid until runtime user-status
 * checks reject them via ban / authInvalidatedAt, but deleting these rows
 * prevents refresh/session flows from minting replacement tokens after disable.
 */
export const revokeOIDCArtifactsByUserId = async (db: LobeChatDatabase, userId: string) => {
  await db.transaction(async (tx) => {
    const deleteByUserId = async (table: OIDCUserArtifactTable) =>
      tx.delete(table).where(eq(table.userId, userId));

    await Promise.all(OIDC_USER_ARTIFACT_TABLES.map(deleteByUserId));
  });
};

export interface AssertUserActiveOptions {
  /**
   * Session createdAt (Better Auth) or token iat (OIDC) / API-key createdAt
   * for authInvalidatedAt cutoff. Not used for reauth.
   */
  credentialIssuedAt?: Date | null;
  /**
   * Trusted Better Auth session id only. Candidate for cutoff exception when it
   * matches users.auth_invalidated_excluded_session_id — still requires a live
   * auth_sessions row (R3-01). Never a token. OIDC/API-key must omit this.
   */
  sessionId?: string | null;
}

const isLiveBetterAuthSession = async (
  db: LobeChatDatabase,
  params: { sessionId: string; userId: string },
): Promise<boolean> => {
  const now = new Date();
  const [row] = await db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.id, params.sessionId),
        eq(session.userId, params.userId),
        gt(session.expiresAt, now),
      ),
    )
    .limit(1);

  return Boolean(row);
};

/**
 * Live-validate a retained-session exception against Better Auth session table.
 * Requires: same id + userId + expiresAt > now. Does not select tokens.
 */
export const isLiveRetainedSessionException = async (
  db: LobeChatDatabase,
  params: {
    excludedSessionId: string | null | undefined;
    sessionId: string | null | undefined;
    userId: string;
  },
): Promise<boolean> => {
  if (
    !params.excludedSessionId ||
    !params.sessionId ||
    params.sessionId !== params.excludedSessionId
  ) {
    return false;
  }

  return isLiveBetterAuthSession(db, { sessionId: params.sessionId, userId: params.userId });
};

/**
 * Rejects auth when the user is missing, effectively banned, or credential
 * was issued at/before authInvalidatedAt — unless a *live* retained BA session
 * exception applies (R3-01: cookie-cache ghost ids are rejected).
 */
export const assertUserActive = async (
  db: LobeChatDatabase,
  userId: string,
  options: AssertUserActiveOptions = {},
) => {
  const [user] = await db
    .select({
      authInvalidatedAt: users.authInvalidatedAt,
      authInvalidatedExcludedSessionId: users.authInvalidatedExcludedSessionId,
      banExpires: users.banExpires,
      banned: users.banned,
      id: users.id,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || isEffectivelyBanned(user)) {
    throw new OIDCUserInactiveError();
  }

  const sessionId =
    typeof options.sessionId === 'string' && options.sessionId.length > 0
      ? options.sessionId
      : null;

  // Every Better Auth sessionId must have a live auth_sessions row. Targeted
  // revoke deletes the row without advancing authInvalidatedAt; Redis / cookie
  // cache can still present the user. OIDC/API-key omit sessionId.
  // Hot path is memoized by assertUserActiveCached (5s, keyed by sessionId,
  // epoch-bumped on revoke) so this is not a DB hit per request.
  if (sessionId) {
    const live = await isLiveBetterAuthSession(db, { sessionId, userId });
    if (!live) {
      throw new OIDCUserInactiveError();
    }
    if (sessionId === user.authInvalidatedExcludedSessionId) {
      // Live retained BA session: skip cutoff only (ban already checked above).
      return;
    }
  }

  // Pure helper only identifies a candidate; live DB check is required before accept.
  const check: CredentialInvalidationCheck = {
    credentialIssuedAt: options.credentialIssuedAt,
    // Do not pass sessionId into pure helper as auto-bypass — we validate live first.
    sessionId: null,
  };

  if (isCredentialInvalidated(user, check)) {
    throw new OIDCUserInactiveError();
  }
};

/**
 * Rejects stateless OIDC access tokens once their subject is no longer active.
 * @deprecated Prefer assertUserActive — same behavior, shared across auth methods.
 */
export const assertOIDCUserActive = assertUserActive;
