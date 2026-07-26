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
});
