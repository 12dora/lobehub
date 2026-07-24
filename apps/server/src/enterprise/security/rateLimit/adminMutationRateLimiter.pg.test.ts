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
    const cleanupBatchSize = 5;
    const config = {
      ...resolveAdminMutationRateLimitConfig({}),
      cleanupBatchSize,
      cleanupMinIntervalMs: 0,
      limit: 3,
      retentionMs: 1,
      windowMs: 60_000,
    };
    const limiter = new SharedAdminMutationRateLimiter({ config });

    // Seed stale rows via SQL (deterministic age; no wall-clock wait).
    const staleStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const staleCount = 10;
    for (let i = 0; i < staleCount; i++) {
      const digest = `${i.toString(16).padStart(2, '0')}${'c'.repeat(62)}`;
      await db.insert(platformAdminMutationRateWindows).values({
        count: 1,
        scopeDigest: digest,
        updatedAt: staleStart,
        windowMs: 60_000,
        windowStart: staleStart,
      });
    }
    expect((await db.select().from(platformAdminMutationRateWindows)).length).toBe(staleCount);

    // Fresh scope consume triggers opportunistic cleanup (fire-and-forget).
    await expect(
      limiter.consume({ actorId: 'fresh', db, procedure: 'admin.agents.create' }),
    ).resolves.toBe('allowed');

    // Wait for async cleanup to delete a bounded batch of stale rows.
    const isStaleDigest = (d: string) => /^[0-9a-f]{2}c{62}$/.test(d);
    let staleRemaining = staleCount;
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await db.select().from(platformAdminMutationRateWindows);
      staleRemaining = rows.filter((r) => isStaleDigest(r.scopeDigest)).length;
      if (staleRemaining < staleCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // First cleanup batch is bounded by cleanupBatchSize.
    expect(staleRemaining).toBe(staleCount - cleanupBatchSize);

    // Fresh scope still enforced exactly; cleanup must not expand quota.
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
