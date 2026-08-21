import type { LobeChatDatabase } from '@lobechat/database';

import { isOIDCUserInactiveError } from '@/libs/oidc-provider/access-control';
import { assertUserActiveCached } from '@/libs/oidc-provider/userActiveCache';

interface BetterAuthFindSessionResult {
  session?: { createdAt?: Date | string | null; id?: string | null };
  user?: { id?: string | null };
}

interface BetterAuthInternalAdapter {
  findSession: (token: string) => Promise<BetterAuthFindSessionResult | null>;
}

interface BetterAuthContext {
  internalAdapter?: BetterAuthInternalAdapter;
}

/**
 * After Better Auth resolves a session (Redis secondaryStorage hit included),
 * require a live `auth_sessions` row. Redis eviction is then an optimization:
 * a revoked token whose Redis entry survived still fails closed here.
 *
 * Cookie-cache hits skip `findSession` — WebAPI/tRPC call `assertUserActiveCached`
 * after `getSession` for that path.
 *
 * Inactive users return null (unauthenticated). Raw backend failures rethrow
 * so callers can surface 5xx instead of a false logout.
 */
export const attachBetterAuthSessionLiveness = (auth: unknown, db: LobeChatDatabase): void => {
  if (!auth || typeof auth !== 'object') return;
  const context = (auth as { $context?: Promise<BetterAuthContext> }).$context;
  if (!context || typeof context.then !== 'function') return;

  void context.then((ctx) => {
    const adapter = ctx.internalAdapter;
    const original = adapter?.findSession;
    if (!adapter || typeof original !== 'function') return;

    adapter.findSession = async (token: string) => {
      const found = await original.call(adapter, token);
      const sessionId = typeof found?.session?.id === 'string' ? found.session.id : null;
      const userId = typeof found?.user?.id === 'string' ? found.user.id : null;
      if (!found || !sessionId || !userId) return found;

      const rawCreatedAt = found.session?.createdAt;
      const sessionCreatedAt =
        rawCreatedAt instanceof Date ? rawCreatedAt : rawCreatedAt ? new Date(rawCreatedAt) : null;
      const credentialIssuedAt =
        sessionCreatedAt && !Number.isNaN(sessionCreatedAt.getTime()) ? sessionCreatedAt : null;

      try {
        await assertUserActiveCached(db, userId, { credentialIssuedAt, sessionId });
        return found;
      } catch (error) {
        if (isOIDCUserInactiveError(error)) return null;
        throw error;
      }
    };
  });
};
