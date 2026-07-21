// @vitest-environment node
import dayjs from 'dayjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agents, messages, topics, users } from '../../schemas';
import { agentOperations } from '../../schemas/agentOperations';
import type { LobeChatDatabase } from '../../type';
import { AgentModel } from '../agent';
import { MessageModel } from '../message';
import { PlatformGlobalStatsModel } from '../platform/globalStats';
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
      expect(logs.length).toBeGreaterThan(0);
      const dayWithData = logs.find((l) => l.totalRequests > 0);
      expect(dayWithData?.totalRequests).toBe(2);
      expect(dayWithData?.records.every((r) => r.userDisplay)).toBe(true);

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
});
