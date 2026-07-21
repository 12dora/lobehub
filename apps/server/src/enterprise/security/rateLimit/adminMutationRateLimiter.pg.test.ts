// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAdminMutationRateWindows } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  PostgresAdminMutationRateLimiter,
  resetSharedAdminMutationRateLimiter,
  SharedAdminMutationRateLimiter,
} from './adminMutationRateLimiter';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformAdminMutationRateWindows);
  resetSharedAdminMutationRateLimiter();
};

beforeEach(cleanup);
afterEach(cleanup);

describe('SharedAdminMutationRateLimiter PostgreSQL fallback (no Redis)', () => {
  it('allows below the limit and denies at the boundary through PostgreSQL', async () => {
    const limiter = new SharedAdminMutationRateLimiter({
      config: { limit: 2, windowMs: 60_000 },
      redis: { tryConsume: async () => 'unavailable' } as never,
    });

    await expect(
      limiter.consume({ actorId: 'actor-1', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      limiter.consume({ actorId: 'actor-1', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      limiter.consume({ actorId: 'actor-1', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('limited');

    // Independent procedure / actor scopes
    await expect(
      limiter.consume({ actorId: 'actor-1', db, procedure: 'admin.agents.archive' }),
    ).resolves.toBe('allowed');
    await expect(
      limiter.consume({ actorId: 'actor-2', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
  });

  it('shares PostgreSQL state across independent limiter instances', async () => {
    const redisUnavailable = { tryConsume: async () => 'unavailable' as const };
    const first = new SharedAdminMutationRateLimiter({
      config: { limit: 2, windowMs: 60_000 },
      redis: redisUnavailable as never,
    });
    const second = new SharedAdminMutationRateLimiter({
      config: { limit: 2, windowMs: 60_000 },
      redis: redisUnavailable as never,
    });

    await expect(
      first.consume({ actorId: 'actor-x', db, procedure: 'admin.system.prepareRestart' }),
    ).resolves.toBe('allowed');
    await expect(
      second.consume({ actorId: 'actor-x', db, procedure: 'admin.system.prepareRestart' }),
    ).resolves.toBe('allowed');
    await expect(
      first.consume({ actorId: 'actor-x', db, procedure: 'admin.system.prepareRestart' }),
    ).resolves.toBe('limited');
  });

  it('fails closed when the PostgreSQL fallback throws', async () => {
    const brokenDb = {
      execute: async () => {
        throw new Error('db down');
      },
    } as never;
    await expect(
      new PostgresAdminMutationRateLimiter({
        config: { limit: 2, windowMs: 60_000 },
      }).consume({ actorId: 'a', db: brokenDb, procedure: 'admin.x' }),
    ).resolves.toBe('unavailable');
  });
});
