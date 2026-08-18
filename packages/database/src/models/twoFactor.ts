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
 */
import { and, eq, exists, not } from 'drizzle-orm';

import { twoFactor, users } from '../schemas';
import type { LobeChatDatabase } from '../type';

export interface TwoFactorEnrollmentState {
  enabled: boolean;
  hasVerifiedFactor: boolean;
}

export const getTwoFactorEnrollmentState = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<TwoFactorEnrollmentState> => {
  const verifiedFactor = db
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(and(eq(twoFactor.userId, users.id), eq(twoFactor.verified, true)));

  const [row] = await db
    .select({
      enabled: users.twoFactorEnabled,
      hasVerifiedFactor: exists(verifiedFactor),
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    enabled: Boolean(row?.enabled),
    hasVerifiedFactor: Boolean(row?.hasVerifiedFactor),
  };
};

/**
 * Atomically clear `two_factor_enabled` only when no verified factor exists.
 * Returns true when a row was repaired.
 */
export const clearOrphanedTwoFactorEnabled = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<boolean> => {
  const verifiedFactor = db
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(and(eq(twoFactor.userId, users.id), eq(twoFactor.verified, true)));

  const updated = await db
    .update(users)
    .set({ twoFactorEnabled: false, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.twoFactorEnabled, true), not(exists(verifiedFactor))))
    .returning({ id: users.id });

  return updated.length > 0;
};
