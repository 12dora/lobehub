/** @vitest-environment node */
import { betterAuth } from 'better-auth';
import type { MemoryDB } from 'better-auth/adapters/memory';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it } from 'vitest';

/**
 * Better Auth 1.6 `findSession` (internal-adapter.mjs):
 *   Redis miss + (!storeSessionInDatabase || preserveSessionInDatabase) → null
 *   Redis miss + storeSessionInDatabase && !preserveSessionInDatabase → DB row
 * `deleteSession`:
 *   preserveSessionInDatabase → Redis delete only (DB row kept)
 *   else + storeSessionInDatabase → Redis + DB delete
 *
 * Our config leaves preserve unset (false) so a flushed Redis key still
 * authenticates, and a revoked session is gone from the DB.
 */
const createAuth = (options?: { preserveSessionInDatabase?: boolean }) => {
  const database: MemoryDB = {
    account: [],
    session: [],
    user: [],
    verification: [],
  };
  const redis = new Map<string, string>();

  const auth = betterAuth({
    baseURL: 'http://localhost:3210',
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true },
    secret: 'test-auth-secret-that-is-long-enough-32b',
    secondaryStorage: {
      delete: async (key: string) => {
        redis.delete(key);
      },
      get: async (key: string) => redis.get(key) ?? null,
      set: async (key: string, value: string) => {
        redis.set(key, value);
      },
    },
    session: {
      storeSessionInDatabase: true,
      ...(options?.preserveSessionInDatabase ? { preserveSessionInDatabase: true } : {}),
    },
  });

  return { auth, database, redis };
};

describe('Better Auth session DB fallback (storeSessionInDatabase, preserve default false)', () => {
  it('finds a valid DB session after the Redis key is missing, and returns null after revoke', async () => {
    const { auth, database, redis } = createAuth();
    const ctx = await auth.$context;

    const user = await ctx.internalAdapter.createUser({
      email: 'session-fallback@example.test',
      name: 'Fallback',
    });
    const session = await ctx.internalAdapter.createSession(user.id, false);

    expect(await ctx.internalAdapter.findSession(session.token)).toMatchObject({
      session: { token: session.token },
      user: { id: user.id },
    });
    expect(redis.has(session.token)).toBe(true);
    expect(database.session.some((row) => row.token === session.token)).toBe(true);

    redis.delete(session.token);
    expect(redis.has(session.token)).toBe(false);

    await expect(ctx.internalAdapter.findSession(session.token)).resolves.toMatchObject({
      session: { token: session.token },
      user: { id: user.id },
    });

    await ctx.internalAdapter.deleteSession(session.token);

    await expect(ctx.internalAdapter.findSession(session.token)).resolves.toBeNull();
    expect(database.session.some((row) => row.token === session.token)).toBe(false);
  });

  it('does not fall back to the DB row when preserveSessionInDatabase is true', async () => {
    const { auth, redis } = createAuth({ preserveSessionInDatabase: true });
    const ctx = await auth.$context;

    const user = await ctx.internalAdapter.createUser({
      email: 'session-preserve@example.test',
      name: 'Preserve',
    });
    const session = await ctx.internalAdapter.createSession(user.id, false);
    redis.delete(session.token);

    await expect(ctx.internalAdapter.findSession(session.token)).resolves.toBeNull();
  });
});
