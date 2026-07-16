import type { LobeChatDatabase } from '@lobechat/database';
import {
  oidcAccessTokens,
  oidcAuthorizationCodes,
  oidcDeviceCodes,
  oidcGrants,
  oidcRefreshTokens,
  oidcSessions,
  users,
} from '@lobechat/database/schemas';
import { eq } from 'drizzle-orm';

import { isCredentialInvalidated, isEffectivelyBanned } from '@/database/utils/userBan';

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
   * Trusted Better Auth session id only — enables cutoff exception when it
   * matches users.auth_invalidated_excluded_session_id. Never a token.
   * OIDC/API-key must omit this.
   */
  sessionId?: string | null;
}

/**
 * Rejects auth when the user is missing, effectively banned, or credential
 * was issued at/before authInvalidatedAt (unless retained BA session exception).
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

  if (
    isCredentialInvalidated(user, {
      credentialIssuedAt: options.credentialIssuedAt,
      sessionId: options.sessionId,
    })
  ) {
    throw new OIDCUserInactiveError();
  }
};

/**
 * Rejects stateless OIDC access tokens once their subject is no longer active.
 * @deprecated Prefer assertUserActive — same behavior, shared across auth methods.
 */
export const assertOIDCUserActive = assertUserActive;
