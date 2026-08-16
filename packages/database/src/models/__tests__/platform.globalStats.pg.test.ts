// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { ensureServerTestDatabase } from '../../../tests/ensureServerTestDatabase';
import * as schema from '../../schemas';
import { messages, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { PlatformGlobalStatsModel } from '../platform/globalStats';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

describe.skipIf(!enabled)('PlatformGlobalStatsModel PostgreSQL UTC buckets', () => {
  it('keeps month boundaries in UTC when the PostgreSQL session is non-UTC', async () => {
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    await ensureServerTestDatabase(connectionString);

    const pool = new Pool({ connectionString, max: 1 });
    const db = drizzle(pool, { schema }) as unknown as LobeChatDatabase;
    const suffix = randomUUID().replaceAll('-', '');
    const userId = `utc-bucket-user-${suffix}`;
    const messageIds = [
      `utc-before-${suffix}`,
      `utc-start-${suffix}`,
      `utc-end-${suffix}`,
      `utc-after-${suffix}`,
    ];

    try {
      await pool.query(`SET TIME ZONE 'Asia/Singapore'`);
      await db.insert(users).values({ id: userId, username: `utc-${suffix}` });
      await db.insert(messages).values([
        {
          content: 'before',
          createdAt: new Date('2024-05-31T23:59:59.999Z'),
          id: messageIds[0],
          role: 'assistant',
          userId,
        },
        {
          content: 'start',
          createdAt: new Date('2024-06-01T00:00:00.000Z'),
          id: messageIds[1],
          model: 'utc-model',
          provider: 'utc-provider',
          role: 'assistant',
          userId,
        },
        {
          content: 'end',
          createdAt: new Date('2024-06-30T23:59:59.999Z'),
          id: messageIds[2],
          model: 'utc-model',
          provider: 'utc-provider',
          role: 'assistant',
          userId,
        },
        {
          content: 'after',
          createdAt: new Date('2024-07-01T00:00:00.000Z'),
          id: messageIds[3],
          role: 'assistant',
          userId,
        },
      ]);

      const days = await new PlatformGlobalStatsModel(db).findAndGroupByDay('2024-06');
      expect(days).toHaveLength(30);
      expect(days.find(({ day }) => day === '2024-06-01')?.totalRequests).toBe(1);
      expect(days.find(({ day }) => day === '2024-06-30')?.totalRequests).toBe(1);
      expect(days.reduce((sum, day) => sum + day.totalRequests, 0)).toBe(2);
    } finally {
      await db.delete(messages).where(inArray(messages.id, messageIds));
      await db.delete(users).where(eq(users.id, userId));
      await pool.query(`SET TIME ZONE 'UTC'`);
      await pool.end();
    }
  }, 60_000);

  it('keeps explicit instant windows and rankUsers stable on a non-UTC session', async () => {
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    await ensureServerTestDatabase(connectionString);

    const pool = new Pool({ connectionString, max: 1 });
    const db = drizzle(pool, { schema }) as unknown as LobeChatDatabase;
    const suffix = randomUUID().replaceAll('-', '');
    const heavyUser = `rank-heavy-${suffix}`;
    const lightUser = `rank-light-${suffix}`;
    const messageIds = [`rank-heavy-${suffix}`, `rank-light-${suffix}`, `rank-outside-${suffix}`];

    try {
      await pool.query(`SET TIME ZONE 'Asia/Singapore'`);
      await db.insert(users).values([
        { fullName: 'Heavy User', id: heavyUser, username: `heavy-${suffix}` },
        { id: lightUser, username: `light-${suffix}` },
      ]);
      await db.insert(messages).values([
        {
          content: 'heavy',
          createdAt: new Date('2024-06-10T16:30:00.000Z'),
          id: messageIds[0],
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant',
          usage: { cost: 1.5, totalInputTokens: 100, totalOutputTokens: 200 },
          userId: heavyUser,
        },
        {
          content: 'light',
          createdAt: new Date('2024-06-10T16:35:00.000Z'),
          id: messageIds[1],
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant',
          usage: { cost: 0.5, totalInputTokens: 10, totalOutputTokens: 20 },
          userId: lightUser,
        },
        {
          // Singapore-local next day, still outside the UTC window below.
          content: 'outside',
          createdAt: new Date('2024-06-11T00:00:00.000Z'),
          id: messageIds[2],
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant',
          usage: { cost: 9, totalInputTokens: 9000, totalOutputTokens: 9000 },
          userId: lightUser,
        },
      ]);

      const model = new PlatformGlobalStatsModel(db);
      const window = {
        endAt: '2024-06-11T00:00:00.000Z',
        startAt: '2024-06-10T00:00:00.000Z',
      };

      const rank = await model.rankUsers(window);
      expect(rank.map(({ userId }) => userId)).toEqual([heavyUser, lightUser]);
      expect(rank[0]).toMatchObject({
        inputTokens: 100,
        messages: 1,
        name: 'Heavy User',
        outputTokens: 200,
        totalTokens: 300,
      });
      expect(rank[0]?.cost).toBeCloseTo(1.5, 5);
      expect(rank[1]).toMatchObject({ name: `light-${suffix}`, totalTokens: 30 });

      const scoped = await model.rankUsers({ ...window, userId: heavyUser });
      expect(scoped.map(({ userId }) => userId)).toEqual([heavyUser]);

      const daily = await model.findDailyTokenTotals(window);
      expect(daily).toEqual([{ day: '2024-06-10', totalTokens: 330 }]);

      const logs = await model.findAndGroupByDay({ ...window, userId: heavyUser });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.day).toBe('2024-06-10');
      expect(logs[0]?.totalRequests).toBe(1);
      expect(logs[0]?.records.every(({ userId }) => userId === heavyUser)).toBe(true);

      // The requested zone drives the buckets — not the session zone, not UTC.
      const utcSeries = await model.findActivitySeries({ ...window, granularity: 'day' });
      expect(utcSeries).toEqual([{ bucket: '2024-06-10', count: 330, level: 4 }]);

      const shanghaiSeries = await model.findActivitySeries({
        ...window,
        granularity: 'day',
        timeZone: 'Asia/Shanghai',
      });
      expect(shanghaiSeries).toEqual([
        { bucket: '2024-06-10', count: 0, level: 0 },
        // 16:30Z / 16:35Z are past midnight in Shanghai.
        { bucket: '2024-06-11', count: 330, level: 4 },
      ]);
    } finally {
      await db.delete(messages).where(inArray(messages.id, messageIds));
      await db.delete(users).where(inArray(users.id, [heavyUser, lightUser]));
      await pool.query(`SET TIME ZONE 'UTC'`);
      await pool.end();
    }
  }, 60_000);

  it('agrees with PostgreSQL tzdata across both DST transitions', async () => {
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    await ensureServerTestDatabase(connectionString);

    const pool = new Pool({ connectionString, max: 1 });
    const db = drizzle(pool, { schema }) as unknown as LobeChatDatabase;
    const suffix = randomUUID().replaceAll('-', '');
    const userId = `dst-user-${suffix}`;
    const messageIds = [`dst-spring-${suffix}`, `dst-fall-a-${suffix}`, `dst-fall-b-${suffix}`];

    try {
      await pool.query(`SET TIME ZONE 'Asia/Singapore'`);
      await db.insert(users).values({ id: userId, username: `dst-${suffix}` });
      await db.insert(messages).values([
        {
          // 2026-03-08 03:30 America/New_York — the first hour after the spring-forward.
          content: 'spring',
          createdAt: new Date('2026-03-08T07:30:00.000Z'),
          id: messageIds[0],
          role: 'user',
          userId,
        },
        {
          // 2026-11-01 01:30 EDT, then the same wall clock one real hour later in EST.
          content: 'fall first pass',
          createdAt: new Date('2026-11-01T05:30:00.000Z'),
          id: messageIds[1],
          role: 'user',
          userId,
        },
        {
          content: 'fall second pass',
          createdAt: new Date('2026-11-01T06:30:00.000Z'),
          id: messageIds[2],
          role: 'user',
          userId,
        },
      ]);

      const model = new PlatformGlobalStatsModel(db);
      const zone = { metric: 'messages', timeZone: 'America/New_York' } as const;

      // 02:00 never happens on this date, so it must not be zero-filled into the series.
      const spring = await model.findActivitySeries({
        ...zone,
        endAt: '2026-03-08T09:00:00.000Z',
        startAt: '2026-03-08T05:00:00.000Z',
      });
      expect(spring).toEqual([
        { bucket: '2026-03-08T00:00', count: 0, level: 0 },
        { bucket: '2026-03-08T01:00', count: 0, level: 0 },
        { bucket: '2026-03-08T03:00', count: 1, level: 1 },
        { bucket: '2026-03-08T04:00', count: 0, level: 0 },
      ]);

      // 01:00 happens twice; PostgreSQL groups both under one label and so do we.
      const fall = await model.findActivitySeries({
        ...zone,
        endAt: '2026-11-01T08:00:00.000Z',
        startAt: '2026-11-01T04:00:00.000Z',
      });
      expect(fall).toEqual([
        { bucket: '2026-11-01T00:00', count: 0, level: 0 },
        { bucket: '2026-11-01T01:00', count: 2, level: 1 },
        { bucket: '2026-11-01T02:00', count: 0, level: 0 },
      ]);
    } finally {
      await db.delete(messages).where(inArray(messages.id, messageIds));
      await db.delete(users).where(eq(users.id, userId));
      await pool.query(`SET TIME ZONE 'UTC'`);
      await pool.end();
    }
  }, 60_000);
});
