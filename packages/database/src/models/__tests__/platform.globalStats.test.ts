// @vitest-environment node
import dayjs from 'dayjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agents, messages, topics, users } from '../../schemas';
import { agentOperations } from '../../schemas/agentOperations';
import type { LobeChatDatabase } from '../../type';
import { AgentModel } from '../agent';
import { MessageModel } from '../message';
import { MAX_USAGE_DETAIL_ROWS, PlatformGlobalStatsModel } from '../platform/globalStats';
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
