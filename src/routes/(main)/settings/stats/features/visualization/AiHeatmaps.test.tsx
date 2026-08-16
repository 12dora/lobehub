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

import AiHeatmaps from './AiHeatmaps';

const mocks = vi.hoisted(() => ({
  activitySeries: vi.fn(),
  getHeatmaps: vi.fn(),
  getTokenHeatmaps: vi.fn(),
  mutate: vi.fn(),
  swrData: undefined as unknown,
  swrError: undefined as unknown,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.scope === undefined ? key : `${key}:${options.scope}`,
  }),
}));

vi.mock('@lobehub/charts', () => ({
  BarChart: ({ data }: { data: Array<Record<string, unknown>> }) => (
    <div data-labels={data.map((row) => row.bucket).join(',')} data-testid="bar-chart" />
  ),
  Heatmaps: ({ data }: { data: Array<{ date: string }> }) => (
    <div data-dates={data.map((row) => row.date).join(',')} data-testid="heatmaps" />
  ),
}));

vi.mock('@lobehub/ui', () => ({
  Center: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  Tag: ({ children }: { children?: ReactNode }) => <span data-testid="day-tag">{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button data-testid="retry" type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Tabs: () => <div data-testid="type-switch" />,
}));

vi.mock('../components/StatsFormGroup', () => ({
  default: ({
    children,
    extra,
    title,
  }: {
    children?: ReactNode;
    extra?: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      <h2 data-testid="card-title">{title}</h2>
      <div>{extra}</div>
      {children}
    </section>
  ),
}));

vi.mock('./HeatmapStats', () => ({ default: () => null }));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>) => {
    if (key === null)
      return { data: undefined, error: undefined, isLoading: false, mutate: mocks.mutate };
    void fetcher();
    return {
      data: mocks.swrData,
      error: mocks.swrError,
      isLoading: false,
      mutate: mocks.mutate,
    };
  },
}));

const RANGED_SOURCE: StatsDataSource = {
  ...personalStatsDataSource,
  activitySeries: mocks.activitySeries,
  getHeatmaps: mocks.getHeatmaps,
  getTokenHeatmaps: mocks.getTokenHeatmaps,
  scopeKey: 'admin-global',
};

const renderCard = (
  filter?: StatsFilter,
  dataSource: StatsDataSource = RANGED_SOURCE,
  props: { inShare?: boolean } = {},
) => {
  const card = (
    <StatsDataSourceProvider value={dataSource}>
      <AiHeatmaps {...props} />
    </StatsDataSourceProvider>
  );
  return render(filter ? <StatsFilterProvider value={filter}>{card}</StatsFilterProvider> : card);
};

describe('AiHeatmaps', () => {
  beforeEach(() => {
    mocks.activitySeries.mockReset().mockResolvedValue([]);
    mocks.getHeatmaps.mockReset().mockResolvedValue([]);
    mocks.getTokenHeatmaps.mockReset().mockResolvedValue([]);
    mocks.mutate.mockReset();
    mocks.swrData = [];
    mocks.swrError = undefined;
  });

  it('keepsTheCalendarYearSeriesWhenNoFilterIsActive', () => {
    mocks.swrData = [{ count: 3, date: '2026-08-15', level: 1 }];
    renderCard();

    expect(screen.getByTestId('heatmaps')).toBeTruthy();
    expect(screen.getByTestId('card-title').textContent).toBe('stats.lastYearActivity');
    expect(mocks.getTokenHeatmaps).toHaveBeenCalled();
    expect(mocks.activitySeries).not.toHaveBeenCalled();
  });

  it('keepsTheYearSeriesWhenTheDataSourceCannotAnswerForAWindow', () => {
    // The personal page has no ranged endpoint — it must not lose its chart to a filter.
    renderCard(
      {
        endAt: '2026-08-16T09:00:00.000Z',
        rangeLabel: 'Today',
        startAt: '2026-08-16T00:00:00.000Z',
      },
      personalStatsDataSource,
    );

    expect(screen.getByTestId('heatmaps')).toBeTruthy();
    expect(screen.getByTestId('card-title').textContent).toBe('stats.lastYearActivity');
  });

  it('drawsHourlyBarsAndHidesTheDayTagsForAWindowUnder48Hours', () => {
    mocks.swrData = [
      { bucket: '2026-08-16T08:00', count: 4, level: 2 },
      { bucket: '2026-08-16T09:00', count: 9, level: 4 },
    ];
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Today',
      startAt: '2026-08-16T00:00:00.000Z',
    });

    expect(screen.getByTestId('bar-chart').dataset.labels).toBe('08:00,09:00');
    expect(screen.queryByTestId('heatmaps')).toBeNull();
    // "N days" over a sub-48h window would be counting hours and calling them days.
    expect(screen.queryAllByTestId('day-tag')).toHaveLength(0);
    expect(mocks.activitySeries).toHaveBeenCalledWith(
      expect.objectContaining({
        endAt: '2026-08-16T09:30:00.000Z',
        metric: 'tokens',
        startAt: '2026-08-16T00:00:00.000Z',
      }),
    );
  });

  it('drawsDailyBarsForAWindowOfAtMostTwoWeeks', () => {
    mocks.swrData = [
      { bucket: '2026-08-10', count: 4, level: 2 },
      { bucket: '2026-08-11', count: 0, level: 0 },
    ];
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Last 7 days',
      startAt: '2026-08-10T00:00:00.000Z',
    });

    expect(screen.getByTestId('bar-chart').dataset.labels).toBe('8/10,8/11');
    expect(screen.queryByTestId('heatmaps')).toBeNull();
    expect(screen.queryAllByTestId('day-tag')).toHaveLength(2);
  });

  it('trimsTheCalendarToTheSelectedWindowForLongerRanges', () => {
    mocks.swrData = [
      { bucket: '2026-07-18', count: 4, level: 2 },
      { bucket: '2026-07-19', count: 0, level: 0 },
    ];
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Last 30 days',
      startAt: '2026-07-18T00:00:00.000Z',
    });

    expect(screen.getByTestId('heatmaps').dataset.dates).toBe('2026-07-18,2026-07-19');
    expect(screen.queryByTestId('bar-chart')).toBeNull();
  });

  it('namesTheSelectedWindowInTheCardTitle', () => {
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Last 30 days',
      startAt: '2026-07-18T00:00:00.000Z',
    });

    expect(screen.getByTestId('card-title').textContent).toBe('stats.activityInRange:Last 30 days');
  });

  it('fallsBackToAPlainActivityTitleWhenTheFilterCarriesNoRangeLabel', () => {
    renderCard({ userId: 'u-1' });

    expect(screen.getByTestId('card-title').textContent).toBe('stats.activity');
  });

  it('keepsTheLegacyYearPathInTheShareCardEvenWhenTheSourceCouldAnswerForAWindow', () => {
    // The share card is a public snapshot: it must never inherit an admin page filter.
    mocks.swrData = [{ count: 3, date: '2026-08-15', level: 1 }];
    renderCard(
      {
        endAt: '2026-08-16T09:30:00.000Z',
        rangeLabel: 'Today',
        startAt: '2026-08-16T00:00:00.000Z',
        userId: 'u-1',
      },
      RANGED_SOURCE,
      { inShare: true },
    );

    expect(screen.getByTestId('heatmaps').dataset.dates).toBe('2026-08-15');
    expect(screen.queryByTestId('bar-chart')).toBeNull();
    expect(mocks.getHeatmaps).toHaveBeenCalled();
    expect(mocks.activitySeries).not.toHaveBeenCalled();
  });

  it('showsARetryableErrorInsteadOfAPermanentSkeletonWhenTheRangedRequestFails', () => {
    mocks.swrData = undefined;
    mocks.swrError = new Error('boom');
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Today',
      startAt: '2026-08-16T00:00:00.000Z',
    });

    expect(screen.queryByTestId('bar-chart')).toBeNull();
    expect(screen.queryByTestId('heatmaps')).toBeNull();

    fireEvent.click(screen.getByTestId('retry'));
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it('showsARetryableErrorWhenTheUnfilteredYearRequestFails', () => {
    mocks.swrData = undefined;
    mocks.swrError = new Error('boom');
    renderCard();

    expect(screen.queryByTestId('heatmaps')).toBeNull();
    expect(screen.getByTestId('retry')).toBeTruthy();
  });
});
