import { describe, expect, it } from 'vitest';

import {
  activityBucketDay,
  activitySeriesDays,
  activitySpansDays,
  currentDayInZone,
  formatActivityBucketLabel,
  isTerminalDayCurrent,
  resolveActivityView,
  resolveCalendarBlockMetrics,
  summarizeActivitySeries,
  toActivityHourRows,
  toHeatmapActivities,
} from './activity.utils';

describe('resolveActivityView', () => {
  it.each([
    ['today (a few hours)', '2026-08-16T00:00:00.000Z', '2026-08-16T09:30:00.000Z', 'hour'],
    ['24 hours', '2026-08-15T09:30:00.000Z', '2026-08-16T09:30:00.000Z', 'hour'],
    ['just under 48 hours', '2026-08-14T10:00:00.000Z', '2026-08-16T09:00:00.000Z', 'hour'],
    ['exactly 48 hours', '2026-08-14T09:00:00.000Z', '2026-08-16T09:00:00.000Z', 'calendar'],
    ['7 days', '2026-08-10T00:00:00.000Z', '2026-08-16T09:30:00.000Z', 'calendar'],
    ['30 days', '2026-07-17T09:30:00.000Z', '2026-08-16T09:30:00.000Z', 'calendar'],
    ['90 days', '2026-05-18T09:30:00.000Z', '2026-08-16T09:30:00.000Z', 'calendar'],
    ['a year', '2025-08-16T09:30:00.000Z', '2026-08-16T09:30:00.000Z', 'calendar'],
  ])('picks the %s rendering from the window span', (_label, startAt, endAt, expected) => {
    expect(resolveActivityView(startAt, endAt)).toBe(expected);
  });

  it.each([
    ['no bounds', undefined, undefined],
    ['only a start', '2026-08-16T00:00:00.000Z', undefined],
    ['an unparsable bound', 'yesterday', '2026-08-16T00:00:00.000Z'],
    ['an inverted window', '2026-08-16T00:00:00.000Z', '2026-08-15T00:00:00.000Z'],
  ])('falls back to the calendar for %s', (_label, startAt, endAt) => {
    expect(resolveActivityView(startAt, endAt)).toBe('calendar');
  });
});

/** The zero-filled day series the ranged endpoint returns for a window. */
const daySeries = (startDay: string, days: number) =>
  Array.from({ length: days }, (_, index) => {
    const day = new Date(`${startDay}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() + index);
    return { bucket: day.toISOString().slice(0, 10), count: 0, level: 0 };
  });

describe('activitySeriesDays', () => {
  it('counts the calendar days the series covers', () => {
    expect(activitySeriesDays(daySeries('2026-08-10', 7))).toBe(7);
    expect(activitySeriesDays(daySeries('2026-07-18', 30))).toBe(30);
  });

  it('is undefined when there is no series to measure', () => {
    expect(activitySeriesDays()).toBeUndefined();
    expect(activitySeriesDays([])).toBeUndefined();
  });

  it('collapses an hourly series onto the days it straddles', () => {
    expect(
      activitySeriesDays([
        { bucket: '2026-08-15T22:00' },
        { bucket: '2026-08-15T23:00' },
        { bucket: '2026-08-16T00:00' },
      ]),
    ).toBe(2);
  });

  it('holds the 14-day step over a fall-back fortnight that lasts 337 hours', () => {
    // The regression this guards: dividing the elapsed span by 24h rounds the extra
    // hour up to a 15th day, dropping the blocks to 24px and reserving a month-label
    // row the grid is far too narrow to print.
    const elapsedHours =
      (Date.parse('2026-11-02T00:00:00-08:00') - Date.parse('2026-10-19T00:00:00-07:00')) /
      3_600_000;
    expect(elapsedHours).toBe(337);

    const metrics = resolveCalendarBlockMetrics(activitySeriesDays(daySeries('2026-10-19', 14)));
    expect(metrics.blockSize).toBe(28);
    expect(metrics.hideMonthLabels).toBe(true);
  });

  it.each([
    // America/Los_Angeles falls back on 2026-11-01 and springs forward on 2026-03-08:
    // each of these windows straddles one of the two switches.
    ['fall-back', '2026-10-19', 14, 28],
    ['fall-back', '2026-10-05', 35, 24],
    ['fall-back', '2026-08-01', 98, 18],
    ['spring-forward', '2026-02-23', 14, 28],
    ['spring-forward', '2026-02-09', 35, 24],
    ['spring-forward', '2025-12-15', 98, 18],
  ])(
    'holds the step boundary for a %s window from %s of %i days',
    (_label, startDay, days, blockSize) => {
      const metrics = resolveCalendarBlockMetrics(activitySeriesDays(daySeries(startDay, days)));
      expect(metrics.blockSize).toBe(blockSize);
    },
  );
});

describe('resolveCalendarBlockMetrics', () => {
  it.each([
    [7, 28],
    [14, 28],
    [30, 24],
    [35, 24],
    [90, 18],
    [98, 18],
    [366, 14],
  ])('grows the block so a %s-day window is not a stamp', (days, blockSize) => {
    expect(resolveCalendarBlockMetrics(days).blockSize).toBe(blockSize);
  });

  it('keeps the year-view metrics when there is no window to scale to', () => {
    // The unfiltered card and the in-flight skeleton both draw a full year.
    expect(resolveCalendarBlockMetrics()).toEqual({
      blockMargin: 4,
      blockRadius: 2,
      blockSize: 14,
      hideMonthLabels: false,
    });
    expect(resolveCalendarBlockMetrics(undefined, true)).toEqual({
      blockMargin: 3,
      blockRadius: 2,
      blockSize: 6,
      hideMonthLabels: false,
    });
  });

  it('scales down on mobile, where the card is a phone wide', () => {
    expect(resolveCalendarBlockMetrics(7, true).blockSize).toBeLessThan(
      resolveCalendarBlockMetrics(7).blockSize,
    );
    expect(resolveCalendarBlockMetrics(30, true).blockSize).toBe(10);
  });

  it('hides the month labels only where the calendar is too narrow to print one', () => {
    // Under three week columns the chart drops every month label anyway; keeping the
    // row would reserve empty space above the grid and show nothing in it.
    expect(resolveCalendarBlockMetrics(7).hideMonthLabels).toBe(true);
    expect(resolveCalendarBlockMetrics(14).hideMonthLabels).toBe(true);
    expect(resolveCalendarBlockMetrics(15).hideMonthLabels).toBe(false);
    expect(resolveCalendarBlockMetrics(30).hideMonthLabels).toBe(false);
  });
});

describe('formatActivityBucketLabel', () => {
  it('labels an hour bucket with its wall-clock hour', () => {
    expect(formatActivityBucketLabel('2026-08-16T09:00', 'hour')).toBe('09:00');
  });

  it('labels a day bucket as M/D without zero padding', () => {
    expect(formatActivityBucketLabel('2026-08-06', 'calendar')).toBe('8/6');
  });

  it('returns the raw bucket when it is not a shape it knows', () => {
    expect(formatActivityBucketLabel('whenever', 'calendar')).toBe('whenever');
  });

  it('prefixes the calendar day when an hourly window straddles midnight', () => {
    // Same hour on two days would otherwise collapse into one duplicate x-axis index.
    expect(formatActivityBucketLabel('2026-08-15T09:00', 'hour', true)).toBe('8/15 09:00');
    expect(formatActivityBucketLabel('2026-08-16T09:00', 'hour', true)).toBe('8/16 09:00');
  });
});

describe('activitySpansDays', () => {
  it('is false for an empty or single-day series', () => {
    expect(activitySpansDays()).toBe(false);
    expect(
      activitySpansDays([{ bucket: '2026-08-16T08:00' }, { bucket: '2026-08-16T09:00' }]),
    ).toBe(false);
  });

  it('is true once buckets fall on different days', () => {
    expect(
      activitySpansDays([{ bucket: '2026-08-15T23:00' }, { bucket: '2026-08-16T00:00' }]),
    ).toBe(true);
  });
});

describe('toActivityHourRows', () => {
  it('lays a partial day out over the full 24 slots', () => {
    // "Today" ends at the current hour: the blocks must stay under the hour axis
    // instead of sliding left as the day fills up.
    const rows = toActivityHourRows([
      { bucket: '2026-08-16T00:00', count: 0, level: 0 },
      { bucket: '2026-08-16T09:00', count: 12, level: 3 },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe('2026-08-16');
    expect(rows[0].dayLabel).toBeUndefined();
    expect(rows[0].hours).toHaveLength(24);
    expect(rows[0].hours[9]).toEqual({ count: 12, label: '09:00', level: 3 });
    expect(rows[0].hours[10]).toBeUndefined();
  });

  it('splits a window that straddles midnight into a labelled row per day', () => {
    const rows = toActivityHourRows([
      { bucket: '2026-08-16T00:00', count: 1, level: 1 },
      { bucket: '2026-08-15T23:00', count: 4, level: 2 },
    ]);

    expect(rows.map((row) => row.day)).toEqual(['2026-08-15', '2026-08-16']);
    expect(rows.map((row) => row.dayLabel)).toEqual(['8/15', '8/16']);
    // The same hour on two days is ambiguous without the date.
    expect(rows[0].hours[23]?.label).toBe('8/15 23:00');
    expect(rows[1].hours[0]?.label).toBe('8/16 00:00');
  });

  it('ignores buckets that are not hourly', () => {
    expect(toActivityHourRows()).toEqual([]);
    expect(toActivityHourRows([])).toEqual([]);
    // A day bucket has no hour to place, and must not silently land on midnight.
    expect(toActivityHourRows([{ bucket: '2026-08-16', count: 5, level: 2 }])).toEqual([]);
    expect(toActivityHourRows([{ bucket: '2026-08-16T99:00', count: 5, level: 2 }])).toEqual([]);
  });
});

describe('toHeatmapActivities', () => {
  it('maps buckets onto the calendar Activity shape', () => {
    expect(
      toHeatmapActivities([
        { bucket: '2026-08-15', count: 12, level: 2 },
        { bucket: '2026-08-16', count: 0, level: 0 },
      ]),
    ).toEqual([
      { count: 12, date: '2026-08-15', level: 2 },
      { count: 0, date: '2026-08-16', level: 0 },
    ]);
  });

  it('tolerates a missing series', () => {
    expect(toHeatmapActivities()).toEqual([]);
  });
});

describe('summarizeActivitySeries', () => {
  it('returns zeroes for an empty series', () => {
    expect(summarizeActivitySeries()).toEqual({ current: 0, longest: 0, peak: 0 });
    expect(summarizeActivitySeries([])).toEqual({ current: 0, longest: 0, peak: 0 });
  });

  it('reports the busiest bucket and the longest run of active days', () => {
    const rows = [
      { count: 5, day: '2026-08-10' },
      { count: 9, day: '2026-08-11' },
      { count: 0, day: '2026-08-12' },
      { count: 3, day: '2026-08-13' },
      { count: 4, day: '2026-08-14' },
      { count: 7, day: '2026-08-15' },
    ];

    expect(summarizeActivitySeries(rows)).toEqual({ current: 3, longest: 3, peak: 9 });
  });

  it('does not let today — an unfinished last day — break the current streak', () => {
    const rows = [
      { count: 2, day: '2026-08-14' },
      { count: 6, day: '2026-08-15' },
      { count: 0, day: '2026-08-16' },
    ];

    expect(summarizeActivitySeries(rows, { isTerminalDayCurrent: true })).toEqual({
      current: 2,
      longest: 2,
      peak: 6,
    });
  });

  it('ends the current streak on an inactive last day of a closed historical range', () => {
    const rows = [
      { count: 4, day: '2026-08-01' },
      { count: 0, day: '2026-08-02' },
    ];

    // The window is over: August 2 was genuinely inactive, not merely unfinished.
    expect(summarizeActivitySeries(rows)).toEqual({ current: 0, longest: 1, peak: 4 });
    expect(summarizeActivitySeries(rows, { isTerminalDayCurrent: false })).toEqual({
      current: 0,
      longest: 1,
      peak: 4,
    });
  });

  it('counts an active last day whether or not it is today', () => {
    const rows = [
      { count: 0, day: '2026-08-01' },
      { count: 4, day: '2026-08-02' },
    ];

    expect(summarizeActivitySeries(rows)).toEqual({ current: 1, longest: 1, peak: 4 });
    expect(summarizeActivitySeries(rows, { isTerminalDayCurrent: true })).toEqual({
      current: 1,
      longest: 1,
      peak: 4,
    });
  });

  it('counts streaks over days, not buckets, when the series is hourly', () => {
    const rows = [
      { count: 1, day: '2026-08-15' },
      { count: 4, day: '2026-08-15' },
      { count: 2, day: '2026-08-16' },
    ];

    // Four active hours across two days is a two-day streak, not a four-day one.
    expect(summarizeActivitySeries(rows)).toEqual({ current: 2, longest: 2, peak: 4 });
  });
});

describe('activityBucketDay', () => {
  it('takes the calendar day out of either bucket shape', () => {
    expect(activityBucketDay('2026-08-16T09:00')).toBe('2026-08-16');
    expect(activityBucketDay('2026-08-16')).toBe('2026-08-16');
  });
});

describe('currentDayInZone', () => {
  it('reads the calendar day in the requested zone, not the runtime zone', () => {
    const instant = new Date('2026-08-16T20:00:00.000Z');

    expect(currentDayInZone('UTC', instant)).toBe('2026-08-16');
    expect(currentDayInZone('Asia/Shanghai', instant)).toBe('2026-08-17');
    expect(currentDayInZone('America/Los_Angeles', instant)).toBe('2026-08-16');
  });

  it('falls back to the runtime zone when the zone is unusable', () => {
    expect(currentDayInZone('Not/AZone', new Date('2026-08-16T12:00:00.000Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe('isTerminalDayCurrent', () => {
  const now = new Date('2026-08-16T20:00:00.000Z');

  it('is true when the latest day of the series is today in the display zone', () => {
    const rows = [{ day: '2026-08-15' }, { day: '2026-08-16' }];

    expect(isTerminalDayCurrent(rows, 'UTC', now)).toBe(true);
    // Shanghai is already on the 17th, so the 16th is a finished day there.
    expect(isTerminalDayCurrent(rows, 'Asia/Shanghai', now)).toBe(false);
  });

  it('is false for a closed historical window and for an empty series', () => {
    expect(isTerminalDayCurrent([{ day: '2026-08-01' }, { day: '2026-08-02' }], 'UTC', now)).toBe(
      false,
    );
    expect(isTerminalDayCurrent([], 'UTC', now)).toBe(false);
    expect(isTerminalDayCurrent(undefined, 'UTC', now)).toBe(false);
  });

  it('takes the latest day rather than the last element', () => {
    expect(isTerminalDayCurrent([{ day: '2026-08-16' }, { day: '2026-08-15' }], 'UTC', now)).toBe(
      true,
    );
  });
});
