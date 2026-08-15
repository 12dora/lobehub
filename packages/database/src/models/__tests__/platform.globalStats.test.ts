// @vitest-environment node
import dayjs from 'dayjs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agents, messages, topics, users } from '../../schemas';
import { agentOperations } from '../../schemas/agentOperations';
import type { LobeChatDatabase } from '../../type';
import { AgentModel } from '../agent';
import { MessageModel } from '../message';
import {
  MAX_STATS_RANGE_DAYS,
  MAX_USAGE_DETAIL_ROWS,
  PlatformGlobalStatsModel,
  resolveStatsRange,
  StatsRangeError,
} from '../platform/globalStats';
import { TopicModel } from '../topic';

const serverDB: LobeChatDatabase = await getTestDB();
const globalStats = new PlatformGlobalStatsModel(serverDB);

const USER_A = 'global-stats-user-a';
const USER_B = 'global-stats-user-b';

const cleanup = async () => {
  await serverDB.delete(agentOperations);
  await serverDB.delete(messages);
  await serverDB.delete(topics);
  await serverDB.delete(agents);
  await serverDB.delete(users);
};

beforeEach(async () => {
  await cleanup();
  const now = Date.now();
  await serverDB.insert(users).values([
    {
      fullName: 'Alice Full',
      id: USER_A,
      lastActiveAt: new Date(now),
      username: 'alice',
    },
    {
      email: 'bob@example.com',
      id: USER_B,
      lastActiveAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
      username: 'bob',
    },
  ]);
});

afterEach(async () => {
  await cleanup();
});

describe('PlatformGlobalStatsModel', () => {
  describe('counts', () => {
    it('aggregates messages/topics/agents across all users (sum of per-user models)', async () => {
      await serverDB.insert(agents).values([
        { id: 'agent-a', title: 'A', userId: USER_A, virtual: false },
        { id: 'agent-b', title: 'B', userId: USER_B, virtual: false },
        { id: 'agent-virtual', title: 'V', userId: USER_A, virtual: true },
      ]);
      await serverDB.insert(topics).values([
        { agentId: 'agent-a', id: 'topic-a1', title: 'T1', userId: USER_A },
        { agentId: 'agent-a', id: 'topic-a2', title: 'T2', userId: USER_A },
        { agentId: 'agent-b', id: 'topic-b1', title: 'T3', userId: USER_B },
      ]);
      await serverDB.insert(messages).values([
        { content: 'm1', id: 'm1', role: 'user', userId: USER_A },
        { content: 'm2', id: 'm2', role: 'assistant', userId: USER_A },
        { content: 'm3', id: 'm3', role: 'user', userId: USER_B },
        { content: 'm4', id: 'm4', role: 'assistant', userId: USER_B },
        { content: 'm5', id: 'm5', role: 'assistant', userId: USER_B },
      ]);

      const msgA = await new MessageModel(serverDB, USER_A).count();
      const msgB = await new MessageModel(serverDB, USER_B).count();
      const topicA = await new TopicModel(serverDB, USER_A).count();
      const topicB = await new TopicModel(serverDB, USER_B).count();
      const agentA = await new AgentModel(serverDB, USER_A).countAgents();
      const agentB = await new AgentModel(serverDB, USER_B).countAgents();

      expect(await globalStats.countMessages()).toBe(msgA + msgB);
      expect(await globalStats.countTopics()).toBe(topicA + topicB);
      expect(await globalStats.countAgents()).toBe(agentA + agentB);
      // virtual agent excluded
      expect(await globalStats.countAgents()).toBe(2);
    });

    it('countUsers reports total and recent active', async () => {
      const { active, total } = await globalStats.countUsers({ activeDays: 30 });
      expect(total).toBe(2);
      expect(active).toBe(1); // only USER_A active within 30 days
    });
  });

  describe('rankModels', () => {
    it('ranks models across users and ignores null model', async () => {
      await serverDB.insert(messages).values([
        { content: 'a', id: 'rm1', model: 'gpt-4', role: 'assistant', userId: USER_A },
        { content: 'b', id: 'rm2', model: 'gpt-4', role: 'assistant', userId: USER_B },
        { content: 'c', id: 'rm3', model: 'claude', role: 'assistant', userId: USER_B },
        { content: 'd', id: 'rm4', model: null, role: 'user', userId: USER_A },
      ]);

      const rank = await globalStats.rankModels();
      expect(rank[0]).toMatchObject({ count: 2, id: 'gpt-4' });
      expect(rank.find((r) => r.id === 'claude')?.count).toBe(1);
      expect(rank.every((r) => r.id != null)).toBe(true);

      const userARank = await new MessageModel(serverDB, USER_A).rankModels();
      const userBRank = await new MessageModel(serverDB, USER_B).rankModels();
      const aCount = userARank.find((r) => r.id === 'gpt-4')?.count ?? 0;
      const bCount = userBRank.find((r) => r.id === 'gpt-4')?.count ?? 0;
      expect(rank.find((r) => r.id === 'gpt-4')?.count).toBe(aCount + bCount);
    });
  });

  describe('heatmaps', () => {
    it('sums daily message counts across users and only tokens from assistant', async () => {
      vi.useFakeTimers();
      const fixedDate = new Date('2024-06-15T12:00:00Z');
      vi.setSystemTime(fixedDate);

      const day = dayjs(fixedDate).subtract(2, 'day');
      const dayKey = day.format('YYYY-MM-DD');
      await serverDB.insert(messages).values([
        {
          content: 'u1',
          createdAt: day.toDate(),
          id: 'hm1',
          role: 'user',
          userId: USER_A,
        },
        {
          content: 'a1',
          createdAt: day.toDate(),
          id: 'hm2',
          role: 'assistant',
          usage: { totalTokens: 100 },
          userId: USER_A,
        },
        {
          content: 'a2',
          createdAt: day.toDate(),
          id: 'hm3',
          role: 'assistant',
          usage: { totalTokens: 50 },
          userId: USER_B,
        },
      ]);

      const heatmaps = await globalStats.getHeatmaps();
      const dayRow = heatmaps.find((d) => d.date === dayKey);
      expect(dayRow?.count).toBe(3);

      const tokenMaps = await globalStats.getTokenHeatmaps();
      const tokenRow = tokenMaps.find((d) => d.date === dayKey);
      // only assistant messages contribute tokens
      expect(tokenRow?.count).toBe(150);

      const aTokens = await new MessageModel(serverDB, USER_A).getTokenHeatmaps();
      const bTokens = await new MessageModel(serverDB, USER_B).getTokenHeatmaps();
      const aDay = aTokens.find((d) => d.date === dayKey)?.count ?? 0;
      const bDay = bTokens.find((d) => d.date === dayKey)?.count ?? 0;
      expect(tokenRow?.count).toBe(aDay + bDay);

      vi.useRealTimers();
    });
  });

  describe('usage', () => {
    it('includes userDisplay from fullName → username → email fallback and groups by day', async () => {
      vi.useFakeTimers();
      const fixedDate = new Date('2024-06-15T12:00:00Z');
      vi.setSystemTime(fixedDate);

      const mo = dayjs(fixedDate).format('YYYY-MM');
      const now = dayjs(fixedDate).startOf('month').add(2, 'day').toDate();
      await serverDB.insert(messages).values([
        {
          content: 'a',
          createdAt: now,
          id: 'u1',
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant',
          usage: { cost: 0.1, totalInputTokens: 10, totalOutputTokens: 20 },
          userId: USER_A,
        },
        {
          content: 'b',
          createdAt: now,
          id: 'u2',
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant',
          usage: { cost: 0.2, totalInputTokens: 5, totalOutputTokens: 5 },
          userId: USER_B,
        },
      ]);

      const rows = await globalStats.findByMonth(mo);
      expect(rows).toHaveLength(2);
      const alice = rows.find((r) => r.userId === USER_A);
      const bob = rows.find((r) => r.userId === USER_B);
      expect(alice?.userDisplay).toBe('Alice Full');
      // bob has no fullName → username
      expect(bob?.userDisplay).toBe('bob');

      const logs = await globalStats.findAndGroupByDay(mo);
      // Full calendar month including final day (June has 30 days).
      expect(logs).toHaveLength(dayjs(fixedDate).daysInMonth());
      expect(logs.at(-1)?.day).toBe(dayjs(fixedDate).endOf('month').format('YYYY-MM-DD'));
      const dayWithData = logs.find((l) => l.totalRequests > 0);
      expect(dayWithData?.totalRequests).toBe(2);
      expect(dayWithData?.totalSpend).toBeCloseTo(0.3);
      expect(dayWithData?.totalTokens).toBe(40);
      // Chart path: per-user × model × provider with non-blank userId (GroupBy.User).
      expect(dayWithData?.records).toHaveLength(2);
      const aliceAgg = dayWithData?.records.find((r) => r.userId === USER_A);
      const bobAgg = dayWithData?.records.find((r) => r.userId === USER_B);
      expect(aliceAgg).toMatchObject({
        model: 'gpt-4',
        provider: 'openai',
        userDisplay: 'Alice Full',
        userId: USER_A,
      });
      expect(aliceAgg?.spend).toBeCloseTo(0.1);
      expect(aliceAgg?.totalTokens).toBe(30);
      expect(bobAgg).toMatchObject({
        model: 'gpt-4',
        provider: 'openai',
        userDisplay: 'bob',
        userId: USER_B,
      });
      expect(bobAgg?.spend).toBeCloseTo(0.2);
      expect(bobAgg?.totalTokens).toBe(10);
      // Never emit blank userId series (would break GroupBy.User).
      expect(dayWithData?.records.every((r) => Boolean(r.userId))).toBe(true);

      vi.useRealTimers();
    });

    it('folds high-cardinality model dimensions before returning database rows', async () => {
      const createdAt = new Date('2024-06-10T12:00:00.000Z');
      await serverDB.insert(messages).values(
        Array.from({ length: 40 }, (_, index) => ({
          content: `model-${index}`,
          createdAt,
          id: `cardinality-${index}`,
          model: `model-${index}`,
          provider: 'provider',
          role: 'assistant' as const,
          usage: { totalInputTokens: 1, totalOutputTokens: index + 1 },
          userId: USER_A,
        })),
      );

      const logs = await globalStats.findAndGroupByDay('2024-06');
      const day = logs.find((item) => item.day === '2024-06-10');
      expect(day?.records.length).toBeLessThanOrEqual(31);
      expect(day?.records.some((record) => record.model === '__other__')).toBe(true);
      expect(day?.totalRequests).toBe(40);
    });

    it('includes the final calendar day of the month in daily grouping', async () => {
      vi.useFakeTimers();
      const fixedDate = new Date('2024-06-15T12:00:00Z');
      vi.setSystemTime(fixedDate);

      const mo = '2024-06';
      const monthEnd = dayjs('2024-06-30').hour(15).toDate();
      await serverDB.insert(messages).values({
        content: 'month-end',
        createdAt: monthEnd,
        id: 'month-end-msg',
        model: 'gpt-4',
        provider: 'openai',
        role: 'assistant',
        usage: { cost: 1.5, totalInputTokens: 100, totalOutputTokens: 50 },
        userId: USER_A,
      });

      const logs = await globalStats.findAndGroupByDay(mo);
      expect(logs).toHaveLength(30);
      const last = logs.find((l) => l.day === '2024-06-30');
      expect(last).toBeDefined();
      expect(last?.totalRequests).toBe(1);
      expect(last?.totalSpend).toBe(1.5);
      expect(last?.totalTokens).toBe(150);

      vi.useRealTimers();
    });

    it('includes February 29 in leap-year daily grouping with exactly 29 buckets', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-02-15T12:00:00Z'));

      const mo = '2024-02';
      const leapDay = dayjs('2024-02-29').hour(10).toDate();
      await serverDB.insert(messages).values({
        content: 'leap',
        createdAt: leapDay,
        id: 'leap-day-msg',
        model: 'gpt-4',
        provider: 'openai',
        role: 'assistant',
        usage: { cost: 0.5, totalInputTokens: 10, totalOutputTokens: 10 },
        userId: USER_A,
      });

      const logs = await globalStats.findAndGroupByDay(mo);
      expect(logs).toHaveLength(29);
      const feb29 = logs.find((l) => l.day === '2024-02-29');
      expect(feb29).toBeDefined();
      expect(feb29?.totalRequests).toBe(1);
      expect(feb29?.totalSpend).toBe(0.5);
      expect(feb29?.totalTokens).toBe(20);
      expect(feb29?.records).toHaveLength(1);
      expect(feb29?.records[0]?.model).toBe('gpt-4');
      expect(feb29?.records[0]?.spend).toBe(0.5);
      expect(feb29?.records[0]?.userId).toBe(USER_A);
      expect(feb29?.records[0]?.userDisplay).toBe('Alice Full');

      vi.useRealTimers();
    });

    it('paginates monthly detail without silent full-month truncation', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));

      const mo = '2024-06';
      const base = dayjs('2024-06-10').hour(12);
      await serverDB.insert(messages).values(
        Array.from({ length: 5 }, (_, i) => ({
          content: `p${i}`,
          createdAt: base.add(i, 'minute').toDate(),
          id: `page-msg-${i}`,
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant' as const,
          usage: { cost: 0.01, totalInputTokens: 1, totalOutputTokens: 1 },
          userId: USER_A,
        })),
      );

      const page1 = await globalStats.findByMonthPage(mo, { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await globalStats.findByMonthPage(mo, {
        cursor: page1.nextCursor!,
        limit: 2,
      });
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).toBeTruthy();

      const page3 = await globalStats.findByMonthPage(mo, {
        cursor: page2.nextCursor!,
        limit: 2,
      });
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();

      const allIds = [...page1.items, ...page2.items, ...page3.items].map((r) => r.id);
      expect(new Set(allIds).size).toBe(5);

      // First-page helper never silently returns a capped full month without cursor.
      const firstOnly = await globalStats.findByMonth(mo, { limit: 2 });
      expect(firstOnly).toHaveLength(2);

      vi.useRealTimers();
    });

    it('stops uncapped findByDateRange drain at MAX_USAGE_DETAIL_ROWS', async () => {
      const pageMax = PlatformGlobalStatsModel.USAGE_PAGE_MAX;
      let callCount = 0;
      let totalRequested = 0;

      const spy = vi
        .spyOn(globalStats, 'findByDateRangePage')
        .mockImplementation(async (_startAt, _endAt, options) => {
          callCount += 1;
          const limit = options?.limit ?? pageMax;
          totalRequested += limit;
          // Always claim more pages exist so the drain would be unbounded without the cap.
          const offset = (callCount - 1) * pageMax;
          const items = Array.from({ length: limit }, (_, i) => {
            const n = offset + i;
            const createdAt = new Date(Date.UTC(2024, 5, 1, 0, 0, n % 60));
            return {
              createdAt,
              id: `cap-row-${n}`,
              model: 'gpt-4',
              provider: 'openai',
              spend: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalTokens: 0,
              tps: 0,
              ttft: 0,
              type: 'chat' as const,
              updatedAt: createdAt,
              userDisplay: 'Alice Full',
              userId: USER_A,
            };
          });
          return {
            items,
            nextCursor: `${items.at(-1)!.createdAt.toISOString()}|${items.at(-1)!.id}`,
          };
        });

      const rows = await globalStats.findByDateRange('2024-06-01', '2024-06-30');

      expect(rows).toHaveLength(MAX_USAGE_DETAIL_ROWS);
      expect(totalRequested).toBe(MAX_USAGE_DETAIL_ROWS);
      expect(callCount).toBe(Math.ceil(MAX_USAGE_DETAIL_ROWS / pageMax));
      // One more call would exceed the cap — drain must have stopped.
      expect(callCount).toBeLessThan(Math.ceil((MAX_USAGE_DETAIL_ROWS + pageMax) / pageMax));

      spy.mockRestore();
    });

    it('falls back to legacy flat metadata.tps / metadata.ttft when performance is absent', async () => {
      vi.useFakeTimers();
      const fixedDate = new Date('2024-06-15T12:00:00Z');
      vi.setSystemTime(fixedDate);

      const mo = dayjs(fixedDate).format('YYYY-MM');
      const now = dayjs(fixedDate).startOf('month').add(3, 'day').toDate();
      await serverDB.insert(messages).values([
        {
          content: 'legacy',
          createdAt: now,
          id: 'legacy-flat',
          model: 'gpt-4',
          // Pre-migration shape: tps/ttft on metadata root, not under performance
          metadata: {
            cost: 0.05,
            totalInputTokens: 3,
            totalOutputTokens: 7,
            tps: 12.5,
            ttft: 340,
          },
          provider: 'openai',
          role: 'assistant',
          userId: USER_A,
        },
      ]);

      const rows = await globalStats.findByMonth(mo);
      const legacy = rows.find((r) => r.id === 'legacy-flat');
      expect(legacy).toBeDefined();
      expect(legacy?.tps).toBe(12.5);
      expect(legacy?.ttft).toBe(340);
      expect(legacy?.totalInputTokens).toBe(3);
      expect(legacy?.totalOutputTokens).toBe(7);
      expect(legacy?.spend).toBe(0.05);

      vi.useRealTimers();
    });
  });

  describe('getMaxTaskDuration', () => {
    it('returns the global max wall-clock duration in seconds', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));

      const started = new Date('2026-01-01T00:00:00.000Z');
      const completedShort = new Date('2026-01-01T00:01:00.000Z');
      const completedLong = new Date('2026-01-01T00:10:00.000Z');

      await serverDB.insert(agentOperations).values([
        {
          completedAt: completedShort,
          createdAt: started,
          id: 'op-short',
          startedAt: started,
          status: 'done',
          userId: USER_A,
        },
        {
          completedAt: completedLong,
          createdAt: started,
          id: 'op-long',
          startedAt: started,
          status: 'done',
          userId: USER_B,
        },
      ]);

      const seconds = await globalStats.getMaxTaskDuration();
      expect(seconds).toBe(600);

      vi.useRealTimers();
    });
  });

  describe('month boundary half-open range (DB-008)', () => {
    it('excludes exactly midnight of the next month from June usage', async () => {
      const juneLastMs = new Date('2024-06-30T23:59:59.999Z');
      const julyMidnight = new Date('2024-07-01T00:00:00.000Z');

      await serverDB.insert(messages).values([
        {
          content: 'june-end',
          createdAt: juneLastMs,
          id: 'msg-june-end',
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant',
          usage: { cost: 1, totalInputTokens: 1, totalOutputTokens: 1 },
          userId: USER_A,
        },
        {
          content: 'july-start',
          createdAt: julyMidnight,
          id: 'msg-july-start',
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant',
          usage: { cost: 9, totalInputTokens: 9, totalOutputTokens: 9 },
          userId: USER_A,
        },
      ]);

      const juneRows = await globalStats.findByMonth('2024-06');
      expect(juneRows.map((r) => r.id)).toEqual(['msg-june-end']);
      expect(juneRows.map((r) => r.id)).not.toContain('msg-july-start');

      const page = await globalStats.findByMonthPage('2024-06', { limit: 50 });
      expect(page.items.map((r) => r.id)).toEqual(['msg-june-end']);

      const bounded = await globalStats.findByMonthBounded('2024-06', 50);
      expect(bounded.items.map((r) => r.id)).toEqual(['msg-june-end']);

      const chart = await globalStats.findAndGroupByDay('2024-06');
      expect(chart.some((d) => d.day === '2024-07-01')).toBe(false);
      const june30 = chart.find((d) => d.day === '2024-06-30');
      expect(june30?.totalRequests).toBe(1);
    });
  });

  describe('resolveStatsRange', () => {
    it('maps a month to a half-open UTC window', () => {
      const range = resolveStatsRange('2024-06');
      expect(range.startAt.toISOString()).toBe('2024-06-01T00:00:00.000Z');
      expect(range.endAt.toISOString()).toBe('2024-07-01T00:00:00.000Z');
    });

    it('defaults to the current UTC month without arguments', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-02-15T12:00:00Z'));
      const range = resolveStatsRange();
      expect(range.startAt.toISOString()).toBe('2024-02-01T00:00:00.000Z');
      expect(range.endAt.toISOString()).toBe('2024-03-01T00:00:00.000Z');
      vi.useRealTimers();
    });

    it('lets explicit instants win over mo', () => {
      const range = resolveStatsRange({
        endAt: '2024-06-11T09:30:00.000Z',
        mo: '2020-01',
        startAt: '2024-06-10T09:30:00.000Z',
      });
      expect(range.startAt.toISOString()).toBe('2024-06-10T09:30:00.000Z');
      expect(range.endAt.toISOString()).toBe('2024-06-11T09:30:00.000Z');
    });

    it('keeps legacy calendar-day strings inclusive of the end day', () => {
      const range = resolveStatsRange({ endAt: '2024-06-30', startAt: '2024-06-01' });
      expect(range.startAt.toISOString()).toBe('2024-06-01T00:00:00.000Z');
      expect(range.endAt.toISOString()).toBe('2024-07-01T00:00:00.000Z');
    });

    it('rejects reversed, empty, and oversized windows', () => {
      expect(() =>
        resolveStatsRange({
          endAt: '2024-06-01T00:00:00.000Z',
          startAt: '2024-06-02T00:00:00.000Z',
        }),
      ).toThrow(StatsRangeError);
      expect(() =>
        resolveStatsRange({
          endAt: '2024-06-01T00:00:00.000Z',
          startAt: '2024-06-01T00:00:00.000Z',
        }),
      ).toThrow(StatsRangeError);

      const start = new Date('2024-01-01T00:00:00.000Z');
      const tooLong = new Date(start.getTime() + (MAX_STATS_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000);
      expect(() => resolveStatsRange({ endAt: tooLong, startAt: start })).toThrow(StatsRangeError);
      expect(() =>
        resolveStatsRange({
          endAt: new Date(start.getTime() + MAX_STATS_RANGE_DAYS * 24 * 60 * 60 * 1000),
          startAt: start,
        }),
      ).not.toThrow();
    });

    it('rejects unparsable bounds', () => {
      expect(() => resolveStatsRange({ startAt: 'not-a-date' })).toThrow(StatsRangeError);
      expect(() => resolveStatsRange({ endAt: 'not-a-date' })).toThrow(StatsRangeError);
    });
  });

  describe('time range and user filters', () => {
    const IN_WINDOW = new Date('2024-06-10T10:00:00.000Z');
    const OUT_OF_WINDOW = new Date('2024-05-10T10:00:00.000Z');
    const WINDOW = {
      endAt: '2024-06-11T00:00:00.000Z',
      startAt: '2024-06-10T00:00:00.000Z',
    };

    beforeEach(async () => {
      await serverDB.insert(agents).values([
        { createdAt: IN_WINDOW, id: 'rg-a', title: 'A', userId: USER_A, virtual: false },
        { createdAt: OUT_OF_WINDOW, id: 'rg-old', title: 'Old', userId: USER_A, virtual: false },
        { createdAt: IN_WINDOW, id: 'rg-b', title: 'B', userId: USER_B, virtual: false },
      ]);
      await serverDB.insert(topics).values([
        { agentId: 'rg-a', createdAt: IN_WINDOW, id: 'rt-a1', title: 'T1', userId: USER_A },
        { agentId: 'rg-a', createdAt: IN_WINDOW, id: 'rt-a2', title: 'T2', userId: USER_A },
        { agentId: 'rg-old', createdAt: OUT_OF_WINDOW, id: 'rt-old', title: 'T0', userId: USER_A },
        { agentId: 'rg-b', createdAt: IN_WINDOW, id: 'rt-b1', title: 'T3', userId: USER_B },
      ]);
      await serverDB.insert(messages).values([
        {
          content: 'ask',
          createdAt: IN_WINDOW,
          id: 'rm-a-user',
          role: 'user',
          topicId: 'rt-a1',
          userId: USER_A,
        },
        {
          content: 'reply',
          createdAt: IN_WINDOW,
          id: 'rm-a-1',
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant',
          topicId: 'rt-a1',
          usage: { cost: 0.1, totalInputTokens: 10, totalOutputTokens: 20 },
          userId: USER_A,
        },
        {
          content: 'reply',
          createdAt: IN_WINDOW,
          id: 'rm-b-1',
          model: 'claude',
          provider: 'anthropic',
          role: 'assistant',
          topicId: 'rt-b1',
          usage: { cost: 0.2, totalInputTokens: 5, totalOutputTokens: 5 },
          userId: USER_B,
        },
        {
          content: 'old reply',
          createdAt: OUT_OF_WINDOW,
          id: 'rm-a-old',
          model: 'gpt-4',
          provider: 'openai',
          role: 'assistant',
          topicId: 'rt-old',
          usage: { cost: 5, totalInputTokens: 500, totalOutputTokens: 500 },
          userId: USER_A,
        },
      ]);
    });

    it('counts inside the half-open window only, with explicit instants beating legacy fields', async () => {
      expect(await globalStats.countMessages(WINDOW)).toBe(3);
      expect(await globalStats.countTopics(WINDOW)).toBe(3);
      expect(await globalStats.countAgents(WINDOW)).toBe(2);

      // Explicit instants win over range / startDate / endDate.
      expect(
        await globalStats.countMessages({
          ...WINDOW,
          endDate: '2024-05-31',
          range: ['2024-05-01', '2024-05-31'],
          startDate: '2024-05-01',
        }),
      ).toBe(3);

      // Upper bound is exclusive.
      expect(
        await globalStats.countMessages({
          endAt: '2024-06-10T10:00:00.000Z',
          startAt: '2024-06-01T00:00:00.000Z',
        }),
      ).toBe(0);
    });

    it('scopes counts to a single user', async () => {
      expect(await globalStats.countMessages({ ...WINDOW, userId: USER_A })).toBe(2);
      expect(await globalStats.countTopics({ ...WINDOW, userId: USER_A })).toBe(2);
      expect(await globalStats.countAgents({ ...WINDOW, userId: USER_B })).toBe(1);
      expect(await globalStats.countMessages({ userId: USER_B })).toBe(1);
    });

    it('windows the daily token series and honours the user filter', async () => {
      const days = await globalStats.findDailyTokenTotals(WINDOW);
      expect(days).toHaveLength(1);
      expect(days[0]).toEqual({ day: '2024-06-10', totalTokens: 40 });

      const aliceOnly = await globalStats.findDailyTokenTotals({ ...WINDOW, userId: USER_A });
      expect(aliceOnly[0]?.totalTokens).toBe(30);
    });

    it('groups by day across an arbitrary window and filters by user', async () => {
      const logs = await globalStats.findAndGroupByDay({
        endAt: '2024-06-12T00:00:00.000Z',
        startAt: '2024-06-09T00:00:00.000Z',
      });
      expect(logs.map((log) => log.day)).toEqual(['2024-06-09', '2024-06-10', '2024-06-11']);
      const day = logs.find((log) => log.day === '2024-06-10');
      expect(day?.totalRequests).toBe(2);
      expect(day?.totalTokens).toBe(40);

      const aliceLogs = await globalStats.findAndGroupByDay({ ...WINDOW, userId: USER_A });
      expect(aliceLogs).toHaveLength(1);
      expect(aliceLogs[0]?.totalRequests).toBe(1);
      expect(aliceLogs[0]?.records.every((record) => record.userId === USER_A)).toBe(true);
    });

    it('returns detail rows for an explicit window and user', async () => {
      const rows = await globalStats.findByMonth(WINDOW);
      expect(rows.map((row) => row.id).sort()).toEqual(['rm-a-1', 'rm-b-1']);

      const aliceRows = await globalStats.findByMonth({ ...WINDOW, userId: USER_A });
      expect(aliceRows.map((row) => row.id)).toEqual(['rm-a-1']);

      const bounded = await globalStats.findByMonthBounded({ ...WINDOW, userId: USER_B }, 50);
      expect(bounded.items.map((row) => row.id)).toEqual(['rm-b-1']);
    });

    it('applies window and user filters to the rankings', async () => {
      const models = await globalStats.rankModels(10, WINDOW);
      expect(models.map((row) => row.id).sort()).toEqual(['claude', 'gpt-4']);
      expect(models.find((row) => row.id === 'gpt-4')?.count).toBe(1);

      const aliceModels = await globalStats.rankModels(10, { ...WINDOW, userId: USER_A });
      expect(aliceModels.map((row) => row.id)).toEqual(['gpt-4']);

      const rankedAgents = await globalStats.rankAgents(10, WINDOW);
      expect(rankedAgents.map((row) => row.id)).toEqual(['rg-a', 'rg-b']);
      expect(rankedAgents[0]?.count).toBe(2);

      const aliceAgents = await globalStats.rankAgents(10, { ...WINDOW, userId: USER_A });
      expect(aliceAgents.map((row) => row.id)).toEqual(['rg-a']);

      const rankedTopics = await globalStats.rankTopics(10, WINDOW);
      expect(rankedTopics.map((row) => row.id).sort()).toEqual(['rt-a1', 'rt-b1']);

      const aliceTopics = await globalStats.rankTopics(10, { ...WINDOW, userId: USER_A });
      expect(aliceTopics.map((row) => row.id)).toEqual(['rt-a1']);
    });

    it('ranks users by token usage inside the window', async () => {
      await serverDB
        .update(users)
        .set({ avatar: 'https://example.com/alice.png' })
        .where(eq(users.id, USER_A));

      const rank = await globalStats.rankUsers(WINDOW);
      expect(rank.map((row) => row.userId)).toEqual([USER_A, USER_B]);
      expect(rank[0]).toEqual({
        avatar: 'https://example.com/alice.png',
        cost: expect.closeTo(0.1, 5),
        inputTokens: 10,
        // both the user prompt and the assistant reply belong to the window
        messages: 2,
        name: 'Alice Full',
        outputTokens: 20,
        totalTokens: 30,
        userId: USER_A,
      });
      expect(rank[1]).toMatchObject({
        avatar: null,
        messages: 1,
        name: 'bob',
        totalTokens: 10,
        userId: USER_B,
      });

      const top1 = await globalStats.rankUsers({ ...WINDOW, limit: 1 });
      expect(top1).toHaveLength(1);
      expect(top1[0]?.userId).toBe(USER_A);

      const bobOnly = await globalStats.rankUsers({ ...WINDOW, userId: USER_B });
      expect(bobOnly.map((row) => row.userId)).toEqual([USER_B]);

      // Outside the window the older, much larger row would have won.
      const wide = await globalStats.rankUsers({
        endAt: '2024-06-11T00:00:00.000Z',
        startAt: '2024-05-01T00:00:00.000Z',
      });
      expect(wide[0]).toMatchObject({ totalTokens: 1030, userId: USER_A });
    });

    it('never counts usage payloads carried by non-assistant rows', async () => {
      await serverDB.insert(messages).values({
        content: 'ask with a stray usage payload',
        createdAt: IN_WINDOW,
        id: 'rm-a-user-usage',
        role: 'user',
        topicId: 'rt-a1',
        usage: { cost: 99, totalInputTokens: 9990, totalOutputTokens: 9990 },
        userId: USER_A,
      });

      const rank = await globalStats.rankUsers(WINDOW);
      expect(rank[0]).toMatchObject({
        inputTokens: 10,
        // the user row is still counted as a message, only its usage is ignored
        messages: 3,
        outputTokens: 20,
        totalTokens: 30,
        userId: USER_A,
      });
      expect(rank[0]?.cost).toBeCloseTo(0.1, 5);

      // The same gate applies to the daily series / day grouping.
      const days = await globalStats.findDailyTokenTotals(WINDOW);
      expect(days[0]?.totalTokens).toBe(40);
    });

    it('orders by the requested metric in SQL so limit is a true top-N', async () => {
      // Bob trails on tokens but leads on messages and cost.
      await serverDB.insert(messages).values(
        Array.from({ length: 3 }, (_, index) => ({
          content: `bob-ask-${index}`,
          createdAt: IN_WINDOW,
          id: `rm-b-ask-${index}`,
          role: 'user' as const,
          topicId: 'rt-b1',
          userId: USER_B,
        })),
      );

      const byTokens = await globalStats.rankUsers(WINDOW);
      expect(byTokens.map((row) => row.userId)).toEqual([USER_A, USER_B]);
      expect(byTokens.map((row) => row.totalTokens)).toEqual([30, 10]);

      const byMessages = await globalStats.rankUsers({ ...WINDOW, orderBy: 'messages' });
      expect(byMessages.map((row) => row.userId)).toEqual([USER_B, USER_A]);
      expect(byMessages.map((row) => row.messages)).toEqual([4, 2]);

      const byCost = await globalStats.rankUsers({ ...WINDOW, orderBy: 'cost' });
      expect(byCost.map((row) => row.userId)).toEqual([USER_B, USER_A]);

      // Top-1 per metric, not the token top-1 re-sorted.
      const topMessages = await globalStats.rankUsers({ ...WINDOW, limit: 1, orderBy: 'messages' });
      expect(topMessages.map((row) => row.userId)).toEqual([USER_B]);
      const topTokens = await globalStats.rankUsers({ ...WINDOW, limit: 1 });
      expect(topTokens.map((row) => row.userId)).toEqual([USER_A]);
    });

    it('falls back to the last 30 days when no window is given', async () => {
      // Every seeded row is from 2024-06, i.e. outside the default window.
      expect(await globalStats.rankUsers()).toEqual([]);

      await serverDB.insert(messages).values({
        content: 'recent',
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        id: 'rm-recent',
        model: 'gpt-4',
        provider: 'openai',
        role: 'assistant',
        usage: { cost: 0.4, totalInputTokens: 7, totalOutputTokens: 3 },
        userId: USER_B,
      });

      const rank = await globalStats.rankUsers();
      expect(rank).toHaveLength(1);
      expect(rank[0]).toMatchObject({ messages: 1, totalTokens: 10, userId: USER_B });
    });

    it('windows active users by lastActiveAt', async () => {
      const now = Date.now();
      const wide = await globalStats.userTotals({
        endAt: new Date(now + 60_000),
        startAt: new Date(now - 50 * 24 * 60 * 60 * 1000),
      });
      expect(wide).toEqual({ usersActive: 2, usersTotal: 2 });

      const narrow = await globalStats.userTotals({
        endAt: new Date(now + 60_000),
        startAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
      });
      expect(narrow).toEqual({ usersActive: 1, usersTotal: 2 });
    });
  });

  describe('rankAgents legacy virtual=NULL (DB-009)', () => {
    it('includes virtual=false, virtual=null, and inbox; excludes virtual=true non-inbox', async () => {
      await serverDB.insert(agents).values([
        { id: 'ag-false', title: 'False', userId: USER_A, virtual: false },
        { id: 'ag-null', title: 'Null', userId: USER_A, virtual: null },
        { id: 'ag-true', title: 'True', userId: USER_A, virtual: true },
        {
          id: 'ag-inbox',
          slug: 'inbox',
          title: 'Inbox',
          userId: USER_A,
          virtual: true,
        },
      ]);
      await serverDB.insert(topics).values([
        { agentId: 'ag-false', id: 't-false', title: 'tf', userId: USER_A },
        { agentId: 'ag-null', id: 't-null-1', title: 'tn1', userId: USER_A },
        { agentId: 'ag-null', id: 't-null-2', title: 'tn2', userId: USER_A },
        { agentId: 'ag-true', id: 't-true', title: 'tt', userId: USER_A },
        { agentId: 'ag-inbox', id: 't-inbox', title: 'ti', userId: USER_A },
      ]);

      // countAgents: false + null (not pure virtual true) — same legacy population
      expect(await globalStats.countAgents()).toBe(2);

      const rank = await globalStats.rankAgents(10);
      const ids = rank.map((r) => r.id);
      expect(ids).toContain('ag-null');
      expect(ids).toContain('ag-false');
      expect(ids).toContain('ag-inbox');
      expect(ids).not.toContain('ag-true');

      // Highest topic count among non-virtual is ag-null (2 topics).
      expect(rank[0]?.id).toBe('ag-null');
      expect(rank[0]?.count).toBe(2);
    });
  });
});
