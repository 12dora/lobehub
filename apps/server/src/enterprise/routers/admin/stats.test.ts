// @vitest-environment node
/**
 * admin.stats regressions: metadata redaction and strict date validation.
 */
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  messages,
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { adminRouter } from '../admin';
import { loadAllMonthUsage, toSafeUsageRecord } from './stats';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(adminRouter);
const createCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).stats;

const ids = {
  noAccess: 'stats-no-access',
  reader: 'stats-reader',
  superAdmin: 'stats-super',
};

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const SECRET_PAYLOAD = 'SUPER_SECRET_LOCAL_FILE_CONTENTS_xyzzy';

const cleanup = async () => {
  await db.delete(messages);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

const grantStatsRead = async (userId: string) => {
  const [role] = await db
    .insert(roles)
    .values({ displayName: 'stats_reader', name: 'stats_reader_role', workspaceId: null })
    .returning();
  const permRows = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, [PLATFORM_PERMISSIONS.STATS_READ]));
  await db
    .insert(rolePermissions)
    .values(permRows.map(({ id }) => ({ permissionId: id, roleId: role.id })));
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
  await db.insert(users).values([{ id: ids.reader }, { id: ids.superAdmin }, { id: ids.noAccess }]);
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
    userId: ids.superAdmin,
  });
  await grantStatsRead(ids.reader);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (userId: string) =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId,
    })),
    serverDB: db,
  } as never);

const seedSensitiveUsageMessage = async (userId: string, index: number) => {
  const day = 10 + (index % 18);
  const createdAt = new Date(`2026-03-${String(day).padStart(2, '0')}T12:00:00.000Z`);
  await db.insert(messages).values({
    content: 'assistant reply',
    createdAt,
    id: `msg-stats-${index}`,
    metadata: {
      localSystemToolSnapshots: [
        {
          arguments: { path: '/etc/shadow' },
          content: SECRET_PAYLOAD,
          name: 'read_file',
          result: SECRET_PAYLOAD,
          state: 'done',
        },
      ],
      totalInputTokens: 10,
      totalOutputTokens: 20,
    },
    model: 'gpt-test',
    provider: 'openai',
    role: 'assistant',
    usage: {
      cost: 0.01,
      totalInputTokens: 10,
      totalOutputTokens: 20,
    },
    userId,
  });
};

describe('admin.stats redacts sensitive metadata', () => {
  it('strips localSystemToolSnapshots from both usage endpoints', async () => {
    await seedSensitiveUsageMessage(ids.reader, 0);
    const caller = await callerFor(ids.reader);

    const page = await caller.usageFindByMonth({ mo: '2026-03' });
    expect(page.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(SECRET_PAYLOAD);
    expect(serialized).not.toContain('localSystemToolSnapshots');
    for (const item of page) {
      expect(item.metadata).toBeNull();
    }

    const logs = await caller.usageFindAndGroupByDay({ mo: '2026-03' });
    expect(JSON.stringify(logs)).not.toContain(SECRET_PAYLOAD);
    expect(JSON.stringify(logs)).not.toContain('localSystemToolSnapshots');
    for (const log of logs) {
      for (const record of log.records) {
        expect(record.metadata).toBeNull();
      }
    }
  });

  it('returns every redacted detail row without silent truncation', async () => {
    for (let i = 0; i < 5; i++) {
      await seedSensitiveUsageMessage(ids.reader, i);
    }
    const caller = await callerFor(ids.superAdmin);

    const rows = await caller.usageFindByMonth({ mo: '2026-03' });
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.metadata === null)).toBe(true);

    const logs = await caller.usageFindAndGroupByDay({ mo: '2026-03' });
    const embedded = logs.flatMap((log) => log.records);
    expect(embedded).toHaveLength(5);
    // Daily totals must stay consistent with embedded redacted records (UI aggregates records).
    const totalRequests = logs.reduce((sum, log) => sum + log.totalRequests, 0);
    expect(totalRequests).toBe(embedded.length);
  });

  it('toSafeUsageRecord never copies raw metadata', () => {
    const safe = toSafeUsageRecord({
      createdAt: new Date(),
      id: 'x',
      metadata: {
        localSystemToolSnapshots: [{ content: SECRET_PAYLOAD }],
      } as never,
      model: 'm',
      provider: 'p',
      spend: 1,
      totalInputTokens: 1,
      totalOutputTokens: 1,
      totalTokens: 2,
      tps: 1,
      ttft: 1,
      type: 'chat',
      updatedAt: new Date(),
      userDisplay: 'u',
      userId: 'u1',
    });
    expect(safe.metadata).toBeNull();
    expect(JSON.stringify(safe)).not.toContain(SECRET_PAYLOAD);
  });
});

describe('admin.stats conversation title authorization', () => {
  it('denies rankTopics for STATS_READ-only roles (F4)', async () => {
    const caller = await callerFor(ids.reader);
    await expect(caller.rankTopics()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows rankTopics when the actor also holds conversation audit read', async () => {
    const caller = await callerFor(ids.superAdmin);
    await expect(caller.rankTopics({ limit: 5 })).resolves.toEqual(expect.any(Array));
  });
});

describe('admin.stats full-month truncation', () => {
  it('throws when the page budget is exhausted with remaining rows (F8)', async () => {
    let calls = 0;
    const stub = {
      // Prefer page-walk path: omit findByMonthBounded so the serial fallback is exercised.
      findByMonthPage: async () => {
        calls += 1;
        return {
          items: [
            {
              createdAt: new Date('2026-03-01T00:00:00.000Z'),
              id: `stub-${calls}`,
              model: 'm',
              provider: 'p',
              spend: 0,
              totalInputTokens: 1,
              totalOutputTokens: 1,
              totalTokens: 2,
              tps: 0,
              ttft: 0,
              type: 'chat',
              updatedAt: new Date('2026-03-01T00:00:00.000Z'),
              userDisplay: 'u',
              userId: 'u1',
            },
          ],
          // Always claim more pages so loadAllMonthUsage hits the 200-page ceiling.
          nextCursor: `cursor-${calls}`,
        };
      },
      findByMonth: async () => [],
    };

    await expect(loadAllMonthUsage(stub as never, '2026-03')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(calls).toBe(200);
  });

  it('throws when the single-query bounded path reports hasMore (routers/F4)', async () => {
    let boundedCalls = 0;
    const stub = {
      findByMonthBounded: async (_mo: string | undefined, maxRows: number) => {
        boundedCalls += 1;
        expect(maxRows).toBe(200 * 500);
        return {
          hasMore: true,
          items: Array.from({ length: 3 }, (_, i) => ({
            createdAt: new Date('2026-03-01T00:00:00.000Z'),
            id: `b-${i}`,
            model: 'm',
            provider: 'p',
            spend: 0,
            totalInputTokens: 1,
            totalOutputTokens: 1,
            totalTokens: 2,
            tps: 0,
            ttft: 0,
            type: 'chat' as const,
            updatedAt: new Date('2026-03-01T00:00:00.000Z'),
            userDisplay: 'u',
            userId: 'u1',
          })),
        };
      },
      // If bounded is preferred, page walk must not run.
      findByMonthPage: async () => {
        throw new Error('findByMonthPage must not be called when bounded is available');
      },
      findByMonth: async () => [],
    };

    await expect(loadAllMonthUsage(stub as never, '2026-03')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      // enterprise error body nested under cause / shape varies — match message path too
    });
    expect(boundedCalls).toBe(1);
  });

  it('returns all items from the single-query bounded path when under the ceiling', async () => {
    const stub = {
      findByMonthBounded: async () => ({
        hasMore: false,
        items: [
          {
            createdAt: new Date('2026-03-02T00:00:00.000Z'),
            id: 'ok-1',
            model: 'm',
            provider: 'p',
            spend: 1,
            totalInputTokens: 2,
            totalOutputTokens: 3,
            totalTokens: 5,
            tps: 0,
            ttft: 0,
            type: 'chat' as const,
            updatedAt: new Date('2026-03-02T00:00:00.000Z'),
            userDisplay: 'u',
            userId: 'u1',
          },
        ],
      }),
      findByMonthPage: async () => {
        throw new Error('page path unused');
      },
      findByMonth: async () => [],
    };

    const rows = await loadAllMonthUsage(stub as never, '2026-03');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('ok-1');
  });
});

describe('admin.stats rejects invalid dates', () => {
  it('rejects malformed and impossible months', async () => {
    const caller = await callerFor(ids.reader);
    await expect(caller.usageFindByMonth({ mo: '2026-99' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.usageFindByMonth({ mo: 'not-a-month' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.usageFindAndGroupByDay({ mo: '2026-13' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects malformed, impossible, and reversed count date ranges', async () => {
    const caller = await callerFor(ids.reader);
    await expect(
      caller.countMessages({ range: ['not-a-date', 'also-invalid'] as never }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.countMessages({ range: ['2026-02-30', '2026-03-01'] as never }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.countMessages({ range: ['2026-03-10', '2026-03-01'] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.countMessages({ endDate: '2026-01-01', startDate: '2026-02-01' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('accepts a valid boundary date range', async () => {
    const caller = await callerFor(ids.reader);
    await expect(caller.countMessages({ range: ['2026-03-01', '2026-03-31'] })).resolves.toEqual(
      expect.any(Number),
    );
  });

  it('rejects reversed, oversized, and malformed instant windows', async () => {
    const caller = await callerFor(ids.reader);
    await expect(
      caller.countMessages({
        endAt: '2026-03-01T00:00:00.000Z',
        startAt: '2026-03-10T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.usageFindAndGroupByDay({
        endAt: '2028-01-01T00:00:00.000Z',
        startAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.rankUsers({ endAt: '2026-03-31', startAt: '2026-03-01' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.usageDailyTokenTotals({ startAt: 'not-a-date' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('admin.stats time-range filter', () => {
  const WINDOW = {
    endAt: '2026-03-11T00:00:00.000Z',
    startAt: '2026-03-10T00:00:00.000Z',
  };

  it('lets an explicit window win over mo on the usage endpoints', async () => {
    // Seeded rows live on 2026-03-10 (index 0) and 2026-03-11 (index 1).
    await seedSensitiveUsageMessage(ids.reader, 0);
    await seedSensitiveUsageMessage(ids.reader, 1);
    const caller = await callerFor(ids.reader);

    const rows = await caller.usageFindByMonth({ mo: '2020-01', ...WINDOW });
    expect(rows.map((row) => row.id)).toEqual(['msg-stats-0']);

    const logs = await caller.usageFindAndGroupByDay({ mo: '2020-01', ...WINDOW });
    expect(logs.map((log) => log.day)).toEqual(['2026-03-10']);
    expect(logs[0]?.totalRequests).toBe(1);

    const daily = await caller.usageDailyTokenTotals(WINDOW);
    expect(daily).toEqual([{ day: '2026-03-10', totalTokens: 30 }]);
  });

  it('windows and scopes the counts / rankings', async () => {
    await seedSensitiveUsageMessage(ids.reader, 0);
    await seedSensitiveUsageMessage(ids.reader, 1);
    const caller = await callerFor(ids.reader);

    await expect(caller.countMessages(WINDOW)).resolves.toBe(1);
    await expect(caller.countMessages({ ...WINDOW, userId: ids.superAdmin })).resolves.toBe(0);
    await expect(caller.rankModels({ limit: 5, ...WINDOW })).resolves.toEqual([
      { count: 1, id: 'gpt-test' },
    ]);
  });
});

describe('admin.stats.rankUsers', () => {
  it('denies callers without platform stats read', async () => {
    const caller = await callerFor(ids.noAccess);
    await expect(caller.rankUsers({ limit: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('ranks users by token usage without leaking a raw email field', async () => {
    await seedSensitiveUsageMessage(ids.reader, 0);
    await seedSensitiveUsageMessage(ids.reader, 1);
    const caller = await callerFor(ids.reader);

    const rank = await caller.rankUsers({
      endAt: '2026-04-01T00:00:00.000Z',
      limit: 5,
      startAt: '2026-03-01T00:00:00.000Z',
    });

    expect(rank).toEqual([
      {
        avatar: null,
        cost: expect.closeTo(0.02, 5),
        inputTokens: 20,
        messages: 2,
        name: ids.reader,
        outputTokens: 40,
        totalTokens: 60,
        userId: ids.reader,
      },
    ]);
    expect(JSON.stringify(rank)).not.toContain('email');
    expect(JSON.stringify(rank)).not.toContain(SECRET_PAYLOAD);
  });

  it('bounds an omitted window to the last 30 days', async () => {
    // Seeded rows live in 2026-03, far outside the default window.
    await seedSensitiveUsageMessage(ids.reader, 0);
    const caller = await callerFor(ids.reader);
    await expect(caller.rankUsers()).resolves.toEqual([]);

    await db.insert(messages).values({
      content: 'recent reply',
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      id: 'msg-recent',
      model: 'gpt-test',
      provider: 'openai',
      role: 'assistant',
      usage: { cost: 0.05, totalInputTokens: 3, totalOutputTokens: 4 },
      userId: ids.reader,
    });

    await expect(caller.rankUsers()).resolves.toEqual([
      expect.objectContaining({ messages: 1, totalTokens: 7, userId: ids.reader }),
    ]);
  });

  it('sorts by the requested metric and rejects unknown ones', async () => {
    // superAdmin: 3 assistant replies (90 tokens); reader: 2 replies (60) + 3 plain prompts.
    for (const index of [0, 1]) await seedSensitiveUsageMessage(ids.reader, index);
    for (const index of [2, 3, 4]) await seedSensitiveUsageMessage(ids.superAdmin, index);
    await db.insert(messages).values(
      Array.from({ length: 3 }, (_, index) => ({
        content: `prompt-${index}`,
        createdAt: new Date('2026-03-15T12:00:00.000Z'),
        id: `msg-prompt-${index}`,
        role: 'user' as const,
        userId: ids.reader,
      })),
    );

    const caller = await callerFor(ids.superAdmin);
    const window = { endAt: '2026-04-01T00:00:00.000Z', startAt: '2026-03-01T00:00:00.000Z' };

    const byTokens = await caller.rankUsers(window);
    expect(byTokens.map((row) => row.userId)).toEqual([ids.superAdmin, ids.reader]);

    const byMessages = await caller.rankUsers({ ...window, orderBy: 'messages' });
    expect(byMessages.map((row) => row.userId)).toEqual([ids.reader, ids.superAdmin]);
    expect(byMessages.map((row) => row.messages)).toEqual([5, 3]);

    // limit is applied to the requested metric, not to a token-ordered page.
    await expect(caller.rankUsers({ ...window, limit: 1, orderBy: 'messages' })).resolves.toEqual([
      expect.objectContaining({ userId: ids.reader }),
    ]);

    await expect(caller.rankUsers({ ...window, orderBy: 'spend' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('accepts admin-length user ids and rejects longer ones', async () => {
    const caller = await callerFor(ids.reader);
    await expect(caller.rankUsers({ userId: 'u'.repeat(128) })).resolves.toEqual([]);
    await expect(caller.countMessages({ userId: 'u'.repeat(128) })).resolves.toBe(0);
    await expect(caller.rankUsers({ userId: 'u'.repeat(129) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
