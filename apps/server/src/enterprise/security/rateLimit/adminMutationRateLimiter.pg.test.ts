// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAdminMutationRateWindows } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  PostgresAdminMutationRateLimiter,
  resetSharedAdminMutationRateLimiter,
  resolveAdminMutationRateLimitConfig,
  SharedAdminMutationRateLimiter,
} from './adminMutationRateLimiter';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformAdminMutationRateWindows);
  resetSharedAdminMutationRateLimiter();
};

beforeEach(cleanup);
afterEach(cleanup);

describe('SharedAdminMutationRateLimiter PostgreSQL authority', () => {
  it('allows below the limit and denies at the boundary across independent instances', async () => {
    const config = {
      ...resolveAdminMutationRateLimitConfig({}),
      cleanupMinIntervalMs: 60_000,
      limit: 2,
      windowMs: 60_000,
    };
    const first = new SharedAdminMutationRateLimiter({ config });
    const second = new SharedAdminMutationRateLimiter({ config });

    await expect(
      first.consume({ actorId: 'actor-1', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      second.consume({ actorId: 'actor-1', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      first.consume({ actorId: 'actor-1', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('limited');

    await expect(
      first.consume({ actorId: 'actor-1', db, procedure: 'admin.agents.archive' }),
    ).resolves.toBe('allowed');
    await expect(
      second.consume({ actorId: 'actor-2', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
  });

  it('never expands quota when the database is unavailable', async () => {
    const brokenDb = {
      execute: async () => {
        throw new Error('db down');
      },
    } as never;
    await expect(
      new PostgresAdminMutationRateLimiter({
        config: {
          ...resolveAdminMutationRateLimitConfig({}),
          limit: 2,
          windowMs: 60_000,
        },
      }).consume({ actorId: 'a', db: brokenDb, procedure: 'admin.x' }),
    ).resolves.toBe('unavailable');
  });

  it('runs bounded opportunistic cleanup without expanding quota', async () => {
    const config = {
      ...resolveAdminMutationRateLimitConfig({}),
      cleanupBatchSize: 50,
      cleanupMinIntervalMs: 0,
      limit: 3,
      retentionMs: 1,
      windowMs: 30,
    };
    const limiter = new SharedAdminMutationRateLimiter({ config });

    // Seed many expired-ish scopes by consuming then waiting for window+retention.
    for (let i = 0; i < 10; i++) {
      await limiter.consume({
        actorId: `stale-${i}`,
        db,
        procedure: 'admin.agents.create',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Fresh scope still enforced exactly; cleanup is best-effort side channel.
    await expect(
      limiter.consume({ actorId: 'fresh', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      limiter.consume({ actorId: 'fresh', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      limiter.consume({ actorId: 'fresh', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');
    await expect(
      limiter.consume({ actorId: 'fresh', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('limited');
  });
});
