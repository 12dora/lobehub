/**
 * Shared effective-ban + auth-invalidation predicates (M04).
 * Single source for list/status, auth guards, and active-super counts.
 */
import { type SQL, sql } from 'drizzle-orm';

import { users } from '../schemas/user';

export interface UserBanFields {
  authInvalidatedAt?: Date | null;
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

/**
 * Credential is invalid when issued at/before the user's authInvalidatedAt cutoff.
 * `credentialIssuedAt` is session.createdAt (Better Auth) or token `iat` (OIDC).
 */
export const isCredentialInvalidated = (
  user: Pick<UserBanFields, 'authInvalidatedAt'>,
  credentialIssuedAt: Date | null | undefined,
): boolean => {
  if (!user.authInvalidatedAt) return false;
  if (!credentialIssuedAt || Number.isNaN(credentialIssuedAt.getTime())) {
    // Fail closed when we cannot prove the credential is post-cutoff.
    return true;
  }
  return credentialIssuedAt.getTime() <= user.authInvalidatedAt.getTime();
};
