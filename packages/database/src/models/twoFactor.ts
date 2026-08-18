/**
 * Two-factor enrolment state. Used at the Better Auth session-create boundary
 * to detect the plugin's non-atomic enable path:
 *
 *   users.two_factor_enabled = true
 *   AND NOT EXISTS (verified two_factor row)
 *
 * better-auth flips the user flag and rotates the session *before* marking the
 * factor verified. If that last write fails, every password login demands a
 * second factor that the server will reject as unverified. The honest repair
 * is to clear the flag — there is no usable factor.
 *
 * That same (enabled, unverified) pair is also the in-flight enrolment
 * transition. Callers MUST skip repair on `/two-factor/verify-*` and this
 * helper refuses to clear a row younger than `TWO_FACTOR_ORPHAN_GRACE_MS`.
 * `two_factor` has no timestamp (better-auth's schema); we use `users.updated_at`,
 * which `updateUser({ twoFactorEnabled: true })` stamps immediately before the
 * session create we intercept.
 */
import { and, eq, exists, lt, not, or } from 'drizzle-orm';

import { twoFactor, users } from '../schemas';
import type { LobeChatDatabase } from '../type';

/** Long enough for the enable→verify-totp→mark-verified writes; short enough to heal a crashed enrolment. */
export const TWO_FACTOR_ORPHAN_GRACE_MS = 5 * 60 * 1000;

export interface TwoFactorEnrollmentState {
  enabled: boolean;
  hasUnverifiedFactor: boolean;
  hasVerifiedFactor: boolean;
  userUpdatedAt: Date | null;
}

export const isStaleTwoFactorOrphan = (
  state: TwoFactorEnrollmentState,
  now = Date.now(),
): boolean => {
  if (!state.enabled || state.hasVerifiedFactor) return false;
  if (!state.hasUnverifiedFactor) return true;
  if (!state.userUpdatedAt) return true;
  return now - state.userUpdatedAt.getTime() > TWO_FACTOR_ORPHAN_GRACE_MS;
};

export const getTwoFactorEnrollmentState = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<TwoFactorEnrollmentState> => {
  const verifiedFactor = db
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(and(eq(twoFactor.userId, users.id), eq(twoFactor.verified, true)));
  const anyFactor = db
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(eq(twoFactor.userId, users.id));

  const [row] = await db
    .select({
      enabled: users.twoFactorEnabled,
      hasUnverifiedFactor: exists(anyFactor),
      hasVerifiedFactor: exists(verifiedFactor),
      userUpdatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    enabled: Boolean(row?.enabled),
    hasUnverifiedFactor: Boolean(row?.hasUnverifiedFactor) && !row?.hasVerifiedFactor,
    hasVerifiedFactor: Boolean(row?.hasVerifiedFactor),
    userUpdatedAt: row?.userUpdatedAt ?? null,
  };
};

/**
 * Atomically clear `two_factor_enabled` only when no verified factor exists
 * AND the enrolment is older than the grace window (or there is no factor row).
 * Returns true when a row was repaired.
 */
export const clearOrphanedTwoFactorEnabled = async (
  db: LobeChatDatabase,
  userId: string,
  now = new Date(),
): Promise<boolean> => {
  const verifiedFactor = db
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(and(eq(twoFactor.userId, users.id), eq(twoFactor.verified, true)));
  const anyFactor = db
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(eq(twoFactor.userId, users.id));
  const graceCutoff = new Date(now.getTime() - TWO_FACTOR_ORPHAN_GRACE_MS);

  const updated = await db
    .update(users)
    .set({ twoFactorEnabled: false, updatedAt: now })
    .where(
      and(
        eq(users.id, userId),
        eq(users.twoFactorEnabled, true),
        not(exists(verifiedFactor)),
        or(not(exists(anyFactor)), lt(users.updatedAt, graceCutoff)),
      ),
    )
    .returning({ id: users.id });

  return updated.length > 0;
};
