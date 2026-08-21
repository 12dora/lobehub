import { session } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

/** Default TTL matching the copy-pasted admin router fixtures (1 hour). */
export const LIVE_ACTOR_SESSION_TTL_MS = 3_600_000;

export interface SeedLiveActorSessionParams {
  expiresAt?: Date;
  now?: Date;
  sessionId?: string;
  userId: string;
}

export const liveActorSessionIdFor = (userId: string): string => `actor-sess-${userId}`;

export const liveActorSessionTokenFor = (sessionId: string): string => `tok-${sessionId}`;

/**
 * Insert a live Better Auth `auth_sessions` row so fail-closed `assertUserActive`
 * accepts the actor. Idempotent on `(id)` via `onConflictDoNothing`.
 *
 * Callers must still pass the returned `sessionId` into `createContextInner`.
 */
export const seedLiveActorSession = async (
  db: LobeChatDatabase,
  params: SeedLiveActorSessionParams,
): Promise<string> => {
  const userId = params.userId.trim();
  if (userId.length === 0) {
    throw new Error('seedLiveActorSession: userId must be non-empty');
  }

  const sessionId = (params.sessionId ?? liveActorSessionIdFor(userId)).trim();
  if (sessionId.length === 0) {
    throw new Error('seedLiveActorSession: sessionId must be non-empty');
  }

  const now = params.now ?? new Date();
  await db
    .insert(session)
    .values({
      createdAt: now,
      expiresAt: params.expiresAt ?? new Date(now.getTime() + LIVE_ACTOR_SESSION_TTL_MS),
      id: sessionId,
      token: liveActorSessionTokenFor(sessionId),
      updatedAt: now,
      userId,
    })
    .onConflictDoNothing();

  return sessionId;
};
