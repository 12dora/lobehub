// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOverviewKpis, useOverviewUsageTrend } from './useOverviewStats';

const mocks = vi.hoisted(() => ({
  countAgents: vi.fn(),
  countMessages: vi.fn(),
  countTopics: vi.fn(),
  fetcher: null as null | (() => Promise<unknown>),
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
    totals: mocks.totals,
    usageDailyTokenTotals: mocks.usageDailyTokenTotals,
    usageFindAndGroupByDay: mocks.usageFindAndGroupByDay,
    usageFindByMonth: mocks.usageFindByMonth,
    userTotals: mocks.userTotals,
  },
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (_key: unknown, fetcher: () => Promise<unknown>) => {
    mocks.fetcher = fetcher;
    return {
      data: undefined,
      error: undefined,
      isLoading: true,
      mutate: vi.fn(),
    };
  },
}));

describe('useOverviewStats aggregates', () => {
  beforeEach(() => {
    mocks.fetcher = null;
    mocks.countAgents.mockReset().mockResolvedValue(1);
    mocks.countMessages.mockReset().mockResolvedValue(2);
    mocks.countTopics.mockReset().mockResolvedValue(3);
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
    renderHook(() => useOverviewKpis());
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

  it('overviewUsageTrendUsesAggregatePayload', async () => {
    renderHook(() => useOverviewUsageTrend());
    expect(mocks.fetcher).toBeTypeOf('function');
    const data = await mocks.fetcher!();

    expect(mocks.usageDailyTokenTotals).toHaveBeenCalled();
    expect(mocks.usageFindByMonth).not.toHaveBeenCalled();
    expect(mocks.usageFindAndGroupByDay).not.toHaveBeenCalled();
    // Mapped aggregate shape only — no per-message records.
    expect(data).toEqual([
      { day: '2026-07-01', tokens: 10 },
      { day: '2026-07-02', tokens: 0 },
    ]);
  });
});
