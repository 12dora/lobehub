// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminTimeRangeBounds } from '../primitives/timeRange.utils';
import { useOverviewKpis, useOverviewUsageTrend, useOverviewUserRank } from './useOverviewStats';

const mocks = vi.hoisted(() => ({
  countAgents: vi.fn(),
  countMessages: vi.fn(),
  countTopics: vi.fn(),
  fetcher: null as null | (() => Promise<unknown>),
  key: null as unknown,
  rankUsers: vi.fn(),
  totals: vi.fn(),
  usageDailyTokenTotals: vi.fn(),
  usageFindAndGroupByDay: vi.fn(),
  usageFindByMonth: vi.fn(),
  userTotals: vi.fn(),
}));

vi.mock('@/enterprise/client/services/adminStats', () => ({
  adminStatsService: {
    countAgents: mocks.countAgents,
    countMessages: mocks.countMessages,
    countTopics: mocks.countTopics,
    rankUsers: mocks.rankUsers,
    totals: mocks.totals,
    usageDailyTokenTotals: mocks.usageDailyTokenTotals,
    usageFindAndGroupByDay: mocks.usageFindAndGroupByDay,
    usageFindByMonth: mocks.usageFindByMonth,
    userTotals: mocks.userTotals,
  },
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>) => {
    mocks.key = key;
    mocks.fetcher = fetcher;
    return {
      data: undefined,
      error: undefined,
      isLoading: true,
      mutate: vi.fn(),
    };
  },
}));

const RANGE: AdminTimeRangeBounds = {
  endAt: '2026-07-22T15:30:00.000Z',
  key: '7d',
  startAt: '2026-07-16T00:00:00.000Z',
};

const WINDOW = { endAt: RANGE.endAt, startAt: RANGE.startAt };

describe('useOverviewStats aggregates', () => {
  beforeEach(() => {
    mocks.fetcher = null;
    mocks.key = null;
    mocks.countAgents.mockReset().mockResolvedValue(1);
    mocks.countMessages.mockReset().mockResolvedValue(2);
    mocks.countTopics.mockReset().mockResolvedValue(3);
    mocks.rankUsers.mockReset().mockResolvedValue([]);
    mocks.totals.mockReset().mockResolvedValue({
      agents: 9,
      messages: 9,
      topics: 9,
      usersActive: 9,
      usersTotal: 9,
    });
    mocks.usageDailyTokenTotals.mockReset().mockResolvedValue([
      { day: '2026-07-01', totalTokens: 10 },
      { day: '2026-07-02', totalTokens: 0 },
    ]);
    mocks.usageFindAndGroupByDay.mockReset().mockResolvedValue([]);
    mocks.usageFindByMonth.mockReset().mockResolvedValue([]);
    mocks.userTotals.mockReset().mockResolvedValue({ usersActive: 4, usersTotal: 5 });
  });

  it('overviewKpisDoNotRequestUnusedLifetimeCounts', async () => {
    renderHook(() => useOverviewKpis(RANGE));
    expect(mocks.fetcher).toBeTypeOf('function');
    const data = await mocks.fetcher!();

    expect(mocks.totals).not.toHaveBeenCalled();
    expect(mocks.userTotals).toHaveBeenCalled();
    expect(mocks.countMessages).toHaveBeenCalled();
    expect(mocks.countTopics).toHaveBeenCalled();
    expect(mocks.countAgents).toHaveBeenCalled();
    expect(data).toEqual({
      agents: 1,
      messages: 2,
      topics: 3,
      usersActive: 4,
      usersTotal: 5,
    });
  });

  it('overviewKpisSendTheSelectedWindowToEveryCountAndKeyOnIt', async () => {
    renderHook(() => useOverviewKpis(RANGE));
    await mocks.fetcher!();

    expect(mocks.countMessages).toHaveBeenCalledWith(WINDOW);
    expect(mocks.countTopics).toHaveBeenCalledWith(WINDOW);
    expect(mocks.countAgents).toHaveBeenCalledWith(WINDOW);
    expect(mocks.userTotals).toHaveBeenCalledWith(undefined, WINDOW);
    // The window is part of the cache key, so switching range refetches instead of
    // serving another window's numbers from cache.
    expect(mocks.key).toEqual(expect.arrayContaining([RANGE.startAt, RANGE.endAt]));
  });

  it('overviewUsageTrendUsesAggregatePayload', async () => {
    renderHook(() => useOverviewUsageTrend(RANGE));
    expect(mocks.fetcher).toBeTypeOf('function');
    const data = await mocks.fetcher!();

    expect(mocks.usageDailyTokenTotals).toHaveBeenCalledWith(WINDOW);
    expect(mocks.usageFindByMonth).not.toHaveBeenCalled();
    expect(mocks.usageFindAndGroupByDay).not.toHaveBeenCalled();
    // Mapped aggregate shape only — no per-message records.
    expect(data).toEqual([
      { day: '2026-07-01', tokens: 10 },
      { day: '2026-07-02', tokens: 0 },
    ]);
  });

  it('overviewUserRankRequestsTheTopFiveInsideTheWindow', async () => {
    renderHook(() => useOverviewUserRank(RANGE));
    await mocks.fetcher!();

    expect(mocks.rankUsers).toHaveBeenCalledWith(5, { ...WINDOW, orderBy: 'totalTokens' });
    expect(mocks.key).toEqual(expect.arrayContaining(['totalTokens']));
  });

  it('overviewUserRankAsksTheServerToRankByTheSelectedMetric', async () => {
    renderHook(() => useOverviewUserRank(RANGE, 'messages'));
    await mocks.fetcher!();

    // The top five by messages are a different five than the top five by tokens, so the
    // metric belongs in the request — and in the key, or the cache would answer with the
    // other metric's rows.
    expect(mocks.rankUsers).toHaveBeenCalledWith(5, { ...WINDOW, orderBy: 'messages' });
    expect(mocks.key).toEqual(expect.arrayContaining(['messages']));
  });
});
