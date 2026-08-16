// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  personalStatsDataSource,
  type StatsDataSource,
  StatsDataSourceProvider,
  type StatsFilter,
  StatsFilterProvider,
} from '@/features/SettingsStats';

import HeatmapStats from './HeatmapStats';

const mocks = vi.hoisted(() => ({
  activitySeries: vi.fn(),
  getMaxTaskDuration: vi.fn(),
  getTokenHeatmaps: vi.fn(),
  keys: [] as unknown[][],
  mutate: vi.fn(),
  results: {} as Record<string, { data?: unknown; error?: unknown }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd', () => ({
  Divider: () => null,
}));

vi.mock('@lobehub/ui', () => ({
  Block: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Center: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  Skeleton: { Button: () => <div data-testid={'tile-skeleton'} /> },
  Text: ({
    children,
    onClick,
    role,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    role?: string;
  }) => (
    <span role={role} onClick={onClick}>
      {children}
    </span>
  ),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type={'button'} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>) => {
    if (key === null)
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };

    const segments = key as unknown[];
    const name = String(segments[0]);
    mocks.keys.push(segments);
    void fetcher();
    const result = mocks.results[name] ?? {};
    return {
      data: result.data,
      error: result.error,
      isLoading: false,
      mutate: () => mocks.mutate(name),
    };
  },
}));

const RANGED_SOURCE: StatsDataSource = {
  ...personalStatsDataSource,
  activitySeries: mocks.activitySeries,
  getMaxTaskDuration: mocks.getMaxTaskDuration,
  getTokenHeatmaps: mocks.getTokenHeatmaps,
  scopeKey: 'admin-global',
};

const WEEK_FILTER: StatsFilter = {
  endAt: '2026-08-16T09:30:00.000Z',
  rangeLabel: 'Last 7 days',
  startAt: '2026-08-10T00:00:00.000Z',
  userId: 'u-1',
};

const renderStats = (filter?: StatsFilter, dataSource: StatsDataSource = RANGED_SOURCE) => {
  const strip = (
    <StatsDataSourceProvider value={dataSource}>
      <HeatmapStats />
    </StatsDataSourceProvider>
  );
  return render(filter ? <StatsFilterProvider value={filter}>{strip}</StatsFilterProvider> : strip);
};

const keyFor = (name: string) => mocks.keys.find((key) => key[0] === name);

describe('HeatmapStats', () => {
  beforeEach(() => {
    mocks.activitySeries.mockReset().mockResolvedValue([]);
    mocks.getMaxTaskDuration.mockReset().mockResolvedValue(0);
    mocks.getTokenHeatmaps.mockReset().mockResolvedValue([]);
    mocks.mutate.mockReset();
    mocks.keys = [];
    mocks.results = {};
  });

  it('summarizesTheRangedSeriesAndKeysItByTheSameZoneItRequests', () => {
    mocks.results['stats:activitySeries'] = {
      data: [
        { bucket: '2026-08-10', count: 5, level: 2 },
        { bucket: '2026-08-11', count: 9, level: 4 },
        { bucket: '2026-08-12', count: 0, level: 0 },
        { bucket: '2026-08-13', count: 3, level: 1 },
      ],
    };
    mocks.results['stats:maxTaskDuration'] = { data: 4500 };
    renderStats(WEEK_FILTER);

    expect(mocks.getTokenHeatmaps).not.toHaveBeenCalled();
    const [request] = mocks.activitySeries.mock.calls[0];
    expect(request).toMatchObject({
      endAt: WEEK_FILTER.endAt,
      metric: 'tokens',
      startAt: WEEK_FILTER.startAt,
      userId: 'u-1',
    });

    // The zone shapes the response, so the cache key must carry the very value sent.
    expect(keyFor('stats:activitySeries')?.[2]).toBe(request.timeZone ?? null);
    expect(keyFor('stats:activitySeries')).toEqual(
      expect.arrayContaining(['admin-global', WEEK_FILTER.startAt, WEEK_FILTER.endAt, 'u-1']),
    );

    // Peak bucket, then the trailing / longest runs of active days in the window.
    expect(screen.getByText('9')).toBeTruthy();
    expect(screen.getByText('1h 15m')).toBeTruthy();
    expect(screen.getByText('1 stats.days')).toBeTruthy();
    expect(screen.getByText('2 stats.days')).toBeTruthy();
    expect(screen.getByText('stats.heatmapStats.currentStreak')).toBeTruthy();
    expect(screen.getByText('stats.heatmapStats.longestStreak')).toBeTruthy();
  });

  it('narrowsTheMaxTaskDurationRequestAndItsKeyToTheSelectedWindow', () => {
    renderStats(WEEK_FILTER);

    expect(mocks.getMaxTaskDuration).toHaveBeenCalledWith({
      endAt: WEEK_FILTER.endAt,
      startAt: WEEK_FILTER.startAt,
      userId: 'u-1',
    });
    expect(keyFor('stats:maxTaskDuration')).toEqual([
      'stats:maxTaskDuration',
      'admin-global',
      WEEK_FILTER.startAt,
      WEEK_FILTER.endAt,
      'u-1',
    ]);
  });

  it('keepsTheYearTokenHeatmapAndAnUnscopedDurationWhenNoFilterIsActive', () => {
    mocks.results['stats:heatmaps'] = { data: [{ count: 7, date: '2026-08-15', level: 3 }] };
    renderStats();

    expect(mocks.activitySeries).not.toHaveBeenCalled();
    expect(mocks.getTokenHeatmaps).toHaveBeenCalled();
    expect(mocks.getMaxTaskDuration).toHaveBeenCalledWith(undefined);
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('dropsTheStreakTilesOnAnHourlyWindowWhereTheyWouldCountAtMostTwoDays', () => {
    mocks.results['stats:activitySeries'] = {
      data: [
        { bucket: '2026-08-16T08:00', count: 4, level: 2 },
        { bucket: '2026-08-16T09:00', count: 9, level: 4 },
      ],
    };
    renderStats({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Today',
      startAt: '2026-08-16T00:00:00.000Z',
    });

    expect(screen.getByText('stats.heatmapStats.peakHourlyTokens')).toBeTruthy();
    expect(screen.getByText('stats.heatmapStats.longestTask')).toBeTruthy();
    expect(screen.queryByText('stats.heatmapStats.currentStreak')).toBeNull();
    expect(screen.queryByText('stats.heatmapStats.longestStreak')).toBeNull();
  });

  it('keepsTheStreakTilesOnADayGranularityWindowSuchAsTheLast30Days', () => {
    // Streaks are exactly the day-over-day story a multi-day window is asking about;
    // only the sub-48h window, which has at most two days in it, drops them.
    mocks.results['stats:activitySeries'] = {
      data: [
        { bucket: '2026-08-14', count: 5, level: 2 },
        { bucket: '2026-08-15', count: 9, level: 4 },
      ],
    };
    renderStats({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Last 30 days',
      startAt: '2026-07-17T09:30:00.000Z',
    });

    expect(screen.getByText('stats.heatmapStats.peakTokens')).toBeTruthy();
    expect(screen.getByText('stats.heatmapStats.currentStreak')).toBeTruthy();
    expect(screen.getByText('stats.heatmapStats.longestStreak')).toBeTruthy();
  });

  it('showsARetryableFailureOnTheSeriesTilesInsteadOfAPermanentSkeleton', () => {
    mocks.results['stats:activitySeries'] = { error: new Error('boom') };
    mocks.results['stats:maxTaskDuration'] = { data: 30 };
    renderStats(WEEK_FILTER);

    expect(screen.queryAllByTestId('tile-skeleton')).toHaveLength(0);
    // The duration tile answered, so it keeps its number while the series tiles fail.
    expect(screen.getByText('30s')).toBeTruthy();

    const retries = screen.getAllByRole('button');
    expect(retries).toHaveLength(3);
    fireEvent.click(retries[0]);
    expect(mocks.mutate).toHaveBeenCalledWith('stats:activitySeries');
  });

  it('failsOnlyTheDurationTileWhenTheDurationRequestFails', () => {
    mocks.results['stats:activitySeries'] = {
      data: [{ bucket: '2026-08-10', count: 5, level: 2 }],
    };
    mocks.results['stats:maxTaskDuration'] = { error: new Error('boom') };
    renderStats(WEEK_FILTER);

    expect(screen.getByText('5')).toBeTruthy();

    const retries = screen.getAllByRole('button');
    expect(retries).toHaveLength(1);
    fireEvent.click(retries[0]);
    expect(mocks.mutate).toHaveBeenCalledWith('stats:maxTaskDuration');
  });
});
