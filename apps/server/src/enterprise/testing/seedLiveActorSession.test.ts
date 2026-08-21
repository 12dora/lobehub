/**
 * @vitest-environment node
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { session, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assertUserActive, OIDCUserInactiveError } from '@/libs/oidc-provider/access-control';

import {
  LIVE_ACTOR_SESSION_TTL_MS,
  liveActorSessionIdFor,
  liveActorSessionTokenFor,
  seedLiveActorSession,
} from './seedLiveActorSession';

const makeDb = () => {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return {
    db: { insert } as unknown as LobeChatDatabase,
    insert,
    onConflictDoNothing,
    values,
  };
};

describe('seedLiveActorSession contract', () => {
  it('inserts a live auth_sessions row with per-user defaults and onConflictDoNothing', async () => {
    const { db, insert, onConflictDoNothing, values } = makeDb();
    const now = new Date('2026-01-02T03:04:05.000Z');
    const sessionId = await seedLiveActorSession(db, { now, userId: 'actor-1' });

    expect(sessionId).toBe(liveActorSessionIdFor('actor-1'));
    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith({
      createdAt: now,
      expiresAt: new Date(now.getTime() + LIVE_ACTOR_SESSION_TTL_MS),
      id: 'actor-sess-actor-1',
      token: liveActorSessionTokenFor('actor-sess-actor-1'),
      updatedAt: now,
      userId: 'actor-1',
    });
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it('honours an explicit session id and expiry', async () => {
    const { db, values } = makeDb();
    const now = new Date('2026-01-02T03:04:05.000Z');
    const expiresAt = new Date('2026-01-03T00:00:00.000Z');
    const sessionId = await seedLiveActorSession(db, {
      expiresAt,
      now,
      sessionId: 'keep-sess',
      userId: 'actor-1',
    });

    expect(sessionId).toBe('keep-sess');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt,
        id: 'keep-sess',
        token: 'tok-keep-sess',
        userId: 'actor-1',
      }),
    );
  });

  it('rejects empty userId / sessionId before touching the database', async () => {
    const { db, insert } = makeDb();
    await expect(seedLiveActorSession(db, { userId: '  ' })).rejects.toThrow(
      /userId must be non-empty/,
    );
    await expect(seedLiveActorSession(db, { sessionId: '', userId: 'actor-1' })).rejects.toThrow(
      /sessionId must be non-empty/,
    );
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('seedLiveActorSession live-row fail-closed check', () => {
  let db: LobeChatDatabase;
  const userId = 'seed-live-actor-user';

  beforeAll(async () => {
    db = await getTestDB();
  }, 120_000);

  afterEach(async () => {
    await db.delete(session).where(eq(session.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('lets assertUserActive accept a seeded Better Auth sessionId and reject a ghost id', async () => {
    await db.insert(users).values({ id: userId });
    const sessionId = await seedLiveActorSession(db, { userId });

    await expect(assertUserActive(db, userId, { sessionId })).resolves.toBeUndefined();
    await expect(assertUserActive(db, userId, { sessionId: 'ghost-sess' })).rejects.toBeInstanceOf(
      OIDCUserInactiveError,
    );
  });
});
