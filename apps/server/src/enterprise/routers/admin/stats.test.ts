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
  await db.insert(users).values([{ id: ids.reader }, { id: ids.superAdmin }]);
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
});
