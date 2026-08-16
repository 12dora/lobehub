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
  Heatmaps: ({
    blockSize,
    data,
    hideMonthLabels,
  }: {
    blockSize?: number;
    data: Array<{ date: string }>;
    hideMonthLabels?: boolean;
  }) => (
    <div
      data-block-size={blockSize}
      data-dates={data.map((row) => row.date).join(',')}
      data-hide-month-labels={String(Boolean(hideMonthLabels))}
      data-testid="heatmaps"
    />
  ),
}));

vi.mock('./ActivityHourGrid', () => ({
  default: ({
    customTooltip,
    data,
  }: {
    customTooltip: (cell: { count: number; label: string; level: number }) => ReactNode;
    data?: Array<{ bucket: string; count: number; level: number }>;
  }) => (
    <div
      data-buckets={(data ?? []).map((row) => row.bucket).join(',')}
      data-testid="hour-grid"
      data-tooltip={String(customTooltip({ count: 1200, label: '09:00', level: 3 }))}
    />
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

/**
 * The zero-filled day series the ranged endpoint returns — one bucket per calendar day
 * of the window, which is what the calendar sizes its blocks by.
 */
const daySeries = (startDay: string, days: number) =>
  Array.from({ length: days }, (_, index) => {
    const day = new Date(`${startDay}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() + index);
    return { bucket: day.toISOString().slice(0, 10), count: index, level: index % 5 };
  });

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

    const heatmaps = screen.getByTestId('heatmaps');
    expect(heatmaps.dataset.blockSize).toBe('14');
    expect(heatmaps.dataset.hideMonthLabels).toBe('false');
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

  it('drawsAnHourStripAndHidesTheDayTagsForAWindowUnder48Hours', () => {
    mocks.swrData = [
      { bucket: '2026-08-16T08:00', count: 4, level: 2 },
      { bucket: '2026-08-16T09:00', count: 9, level: 4 },
    ];
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Today',
      startAt: '2026-08-16T00:00:00.000Z',
    });

    const grid = screen.getByTestId('hour-grid');
    expect(grid.dataset.buckets).toBe('2026-08-16T08:00,2026-08-16T09:00');
    // The calendar copy claims a whole day; an hour block states the hour and figure.
    expect(grid.dataset.tooltip).toBe('09:00 · 1,200 stats.tokens');
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

  it('keepsTheCalendarForAWeekAndGrowsItsBlocksSoItIsNotAStamp', () => {
    mocks.swrData = daySeries('2026-08-10', 7);
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Last 7 days',
      startAt: '2026-08-10T00:00:00.000Z',
    });

    const heatmaps = screen.getByTestId('heatmaps');
    expect(heatmaps.dataset.dates?.split(',')).toHaveLength(7);
    expect(heatmaps.dataset.dates?.startsWith('2026-08-10,')).toBe(true);
    expect(heatmaps.dataset.blockSize).toBe('28');
    // Two week columns can never print a month label — do not reserve the row.
    expect(heatmaps.dataset.hideMonthLabels).toBe('true');
    expect(screen.queryByTestId('hour-grid')).toBeNull();
    expect(screen.queryAllByTestId('day-tag')).toHaveLength(2);
  });

  it('trimsTheCalendarToA30DayWindowAtAReadableBlockSize', () => {
    // The regression this guards: 30 days at the year-view block size drew a stamp
    // adrift in a full-width card.
    mocks.swrData = daySeries('2026-07-18', 30);
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Last 30 days',
      startAt: '2026-07-18T00:00:00.000Z',
    });

    const heatmaps = screen.getByTestId('heatmaps');
    expect(heatmaps.dataset.dates?.split(',')).toHaveLength(30);
    expect(heatmaps.dataset.blockSize).toBe('24');
    expect(heatmaps.dataset.hideMonthLabels).toBe('false');
    expect(screen.queryByTestId('hour-grid')).toBeNull();
  });

  it('sizesTheCalendarByItsOwnDaysSoADstWindowDoesNotGainAPhantomDay', () => {
    // 2026-10-19 → 2026-11-02 in America/Los_Angeles is fourteen calendar days but 337
    // elapsed hours: measured by span it would round up to fifteen and drop a step.
    mocks.swrData = daySeries('2026-10-19', 14);
    renderCard({
      endAt: '2026-11-02T00:00:00-08:00',
      rangeLabel: 'Custom',
      startAt: '2026-10-19T00:00:00-07:00',
    });

    const heatmaps = screen.getByTestId('heatmaps');
    expect(heatmaps.dataset.blockSize).toBe('28');
    expect(heatmaps.dataset.hideMonthLabels).toBe('true');
  });

  it('keepsTheYearViewBlockSizeForALongWindow', () => {
    mocks.swrData = daySeries('2025-08-16', 366);
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Last 12 months',
      startAt: '2025-08-16T00:00:00.000Z',
    });

    const heatmaps = screen.getByTestId('heatmaps');
    expect(heatmaps.dataset.dates?.split(',')).toHaveLength(366);
    expect(heatmaps.dataset.blockSize).toBe('14');
  });

  it('holdsTheYearViewBlockSizeWhileTheRangedRequestIsStillInFlight', () => {
    // The in-flight skeleton is a year of columns whatever the window is; drawing it
    // at a short window's block size would blow it far past the card.
    mocks.swrData = undefined;
    renderCard({
      endAt: '2026-08-16T09:30:00.000Z',
      rangeLabel: 'Last 7 days',
      startAt: '2026-08-10T00:00:00.000Z',
    });

    expect(screen.getByTestId('heatmaps').dataset.blockSize).toBe('14');
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
    expect(screen.queryByTestId('hour-grid')).toBeNull();
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

    expect(screen.queryByTestId('hour-grid')).toBeNull();
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
