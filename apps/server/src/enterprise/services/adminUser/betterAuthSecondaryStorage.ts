/**
 * Drop Better Auth Redis (secondaryStorage) entries for revoked session tokens.
 *
 * Targeted revoke deletes PostgreSQL `auth_sessions` rows but does not advance
 * `authInvalidatedAt`. Better Auth `findSession` returns a Redis hit without
 * consulting the DB, so the token must be deleted via the internal adapter
 * (also rewrites `active-sessions-{userId}`).
 *
 * Best-effort: DB row deletion is the source of truth for liveness. Never log tokens.
 */
export const deleteBetterAuthSecondaryStorageSessions = async (tokens: string[]): Promise<void> => {
  if (tokens.length === 0) return;

  try {
    const { auth } = await import('@/auth');
    const context = await auth.$context;
    const deleteSession = context?.internalAdapter?.deleteSession;
    if (typeof deleteSession !== 'function') return;

    await Promise.all(
      tokens.map(async (token) => {
        try {
          await deleteSession(token);
        } catch (error) {
          console.error(
            'Failed to drop Better Auth secondary storage for a revoked session',
            error,
          );
        }
      }),
    );
  } catch (error) {
    console.error('Better Auth secondary storage cleanup skipped', error);
  }
};
