/**
 * Shared effective-ban + auth-invalidation predicates (M04).
 * Single source for list/status, auth guards, and active-super counts.
 */
import { type SQL, sql } from 'drizzle-orm';

import { users } from '../schemas/user';

export interface UserBanFields {
  authInvalidatedAt?: Date | null;
  /** Better Auth session id exempt from cutoff (never a token). */
  authInvalidatedExcludedSessionId?: string | null;
  banExpires: Date | null;
  banned: boolean | null;
}

/**
 * Effective ban: banned=true AND (no expiry OR expiry still in the future).
 * Expired temporary bans are treated as active/not-banned.
 */
export const isEffectivelyBanned = (user: UserBanFields, now = new Date()): boolean => {
  if (!user.banned) return false;
  return !user.banExpires || user.banExpires > now;
};

/** SQL: user is currently under an effective ban. */
export const effectivelyBannedSql = (): SQL =>
  sql`(${users.banned} IS TRUE AND (${users.banExpires} IS NULL OR ${users.banExpires} > NOW()))`;

/** SQL: user is currently active (not effectively banned). */
export const effectivelyActiveSql = (): SQL =>
  sql`(${users.banned} IS NOT TRUE OR (${users.banExpires} IS NOT NULL AND ${users.banExpires} <= NOW()))`;

export interface CredentialInvalidationCheck {
  /**
   * Trusted credential issuance time (session.createdAt / OIDC iat / API-key createdAt).
   * Not reauth time.
   */
  credentialIssuedAt?: Date | null;
  /**
   * Candidate retained Better Auth session id only (never a token).
   * A pure match only identifies a *candidate* exception — production auth
   * paths must live-validate against auth_sessions via assertUserActive.
   * OIDC/API-key must leave this undefined/null.
   */
  sessionId?: string | null;
}

/**
 * Credential is invalid when issued at/before the user's authInvalidatedAt cutoff,
 * unless the supplied sessionId is a candidate retained-session exception.
 * Ban state is checked separately. Live DB validation of the exception is
 * assertUserActive's responsibility (R3-01) — do not trust this helper alone.
 */
export const isCredentialInvalidated = (
  user: Pick<UserBanFields, 'authInvalidatedAt' | 'authInvalidatedExcludedSessionId'>,
  check: CredentialInvalidationCheck | Date | null | undefined,
): boolean => {
  // Back-compat: older call sites passed credentialIssuedAt as the second arg.
  const opts: CredentialInvalidationCheck =
    check instanceof Date || check === null || check === undefined
      ? { credentialIssuedAt: check as Date | null | undefined }
      : check;

  if (!user.authInvalidatedAt) return false;

  const excluded = user.authInvalidatedExcludedSessionId;
  if (
    excluded &&
    typeof opts.sessionId === 'string' &&
    opts.sessionId.length > 0 &&
    opts.sessionId === excluded
  ) {
    // Retained Better Auth session exception only — never OIDC/API-key.
    return false;
  }

  const credentialIssuedAt = opts.credentialIssuedAt;
  if (!credentialIssuedAt || Number.isNaN(credentialIssuedAt.getTime())) {
    // Fail closed when we cannot prove the credential is post-cutoff.
    // Cookie-cache sessions that omit createdAt are only accepted when
    // sessionId matches authInvalidatedExcludedSessionId (handled above) and
    // assertUserActive live-validates the row.
    return true;
  }
  return credentialIssuedAt.getTime() <= user.authInvalidatedAt.getTime();
};
