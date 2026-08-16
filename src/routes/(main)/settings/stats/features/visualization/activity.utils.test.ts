import { describe, expect, it } from 'vitest';

import {
  activityBucketDay,
  activitySpansDays,
  currentDayInZone,
  formatActivityBucketLabel,
  isBucketInRange,
  isTerminalDayCurrent,
  markActivityRange,
  OUT_OF_RANGE_LEVEL_OFFSET,
  resolveActivityView,
  resolveCalendarBlockMetrics,
  resolveCalendarWindow,
  resolveRangeDays,
  rowsInRange,
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

describe('resolveCalendarBlockMetrics', () => {
  it('keeps the year-view metrics without a measured width', () => {
    expect(resolveCalendarBlockMetrics()).toEqual({
      blockMargin: 4,
      blockRadius: 2,
      blockSize: 14,
    });
    expect(resolveCalendarBlockMetrics(0)).toEqual({
      blockMargin: 4,
      blockRadius: 2,
      blockSize: 14,
    });
  });

  it('never grows past the year-view block on a wide card', () => {
    expect(resolveCalendarBlockMetrics(2000).blockSize).toBe(14);
  });

  it('shrinks the block so all 53 week columns fit a narrower card', () => {
    // 53 columns × 12px + 52 gaps × 4px = 844px
    expect(resolveCalendarBlockMetrics(850).blockSize).toBe(12);
    expect(resolveCalendarBlockMetrics(700).blockSize).toBe(9);
  });

  it('tightens the gap before giving up on the block, and never below a legible square', () => {
    // 53 columns × 6px + 52 × 4px = 526px is the last width the roomy gap can hold.
    expect(resolveCalendarBlockMetrics(526)).toMatchObject({ blockMargin: 4, blockSize: 6 });
    // Below that the gap drops to 2px: 53 × 5 + 52 × 2 = 369.
    expect(resolveCalendarBlockMetrics(370)).toMatchObject({ blockMargin: 2, blockSize: 5 });
    expect(resolveCalendarBlockMetrics(100)).toMatchObject({ blockMargin: 2, blockSize: 4 });
  });

  it('keeps every column inside the measured width once it is at all possible', () => {
    for (const width of [320, 400, 526, 600, 760, 900, 1200]) {
      const { blockMargin, blockSize } = resolveCalendarBlockMetrics(width);
      expect(53 * blockSize + 52 * blockMargin).toBeLessThanOrEqual(width);
    }
  });

  it('scales down on mobile, where the card is a phone wide', () => {
    expect(resolveCalendarBlockMetrics(undefined, true)).toEqual({
      blockMargin: 3,
      blockRadius: 2,
      blockSize: 6,
    });
  });
});

describe('resolveCalendarWindow', () => {
  it('draws the 52 weeks that end with the selected window, aligned to a Sunday column', () => {
    // 2026-08-16 is a Sunday; the window ends mid-day (exclusive), so its last day is the 16th.
    const window = resolveCalendarWindow(new Date(2026, 7, 16, 14, 30).toISOString());
    const start = new Date(window!.startAt);
    expect(start.getDay()).toBe(0);
    expect(start.getHours()).toBe(0);
    // 51 weeks back from Sunday the 16th lands on a Sunday too, so no further alignment.
    expect(start.getTime()).toBe(new Date(2026, 7, 16 - 51 * 7).getTime());
    expect(window!.endAt).toBe(new Date(2026, 7, 16, 14, 30).toISOString());
  });

  it('steps the start back to the Sunday when the last day is mid-week', () => {
    // 2026-08-19 is a Wednesday.
    const window = resolveCalendarWindow(new Date(2026, 7, 20).toISOString());
    const start = new Date(window!.startAt);
    expect(start.getDay()).toBe(0);
    const spanDays = (new Date(2026, 7, 20).getTime() - start.getTime()) / 86_400_000;
    expect(spanDays).toBeLessThanOrEqual(366);
    expect(spanDays).toBeGreaterThan(357);
  });

  it('reaches back to the selected start when a custom range is longer than the calendar', () => {
    const endAt = new Date(2026, 7, 16, 9, 30).toISOString();
    const startAt = new Date(2025, 7, 16).toISOString();
    const window = resolveCalendarWindow(endAt, startAt);
    // Every selected day is fetched; the request stays inside the server's 366-day cap.
    expect(window.startAt).toBe(startAt);
    expect((Date.parse(endAt) - Date.parse(window.startAt)) / 86_400_000).toBeLessThanOrEqual(366);
  });

  it('closes at the start of tomorrow when the filter pins only a user', () => {
    const window = resolveCalendarWindow();
    const end = new Date(window.endAt);
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(end.getTime()).toBe(tomorrow.getTime());
    expect(new Date(window.startAt).getDay()).toBe(0);
    expect(resolveCalendarWindow('nope').endAt).toBe(window.endAt);
  });
});

describe('resolveRangeDays', () => {
  it('names the first and last local day a half-open window touches', () => {
    expect(
      resolveRangeDays(new Date(2026, 7, 10).toISOString(), new Date(2026, 7, 17).toISOString()),
    ).toEqual({ firstDay: '2026-08-10', lastDay: '2026-08-16' });
  });

  it('is undefined for a missing or inverted window', () => {
    expect(resolveRangeDays(undefined, new Date().toISOString())).toBeUndefined();
    expect(
      resolveRangeDays(new Date(2026, 7, 17).toISOString(), new Date(2026, 7, 10).toISOString()),
    ).toBeUndefined();
  });
});

describe('range marking', () => {
  const range = { firstDay: '2026-08-10', lastDay: '2026-08-16' };

  it('tells the selected days from the rest of the calendar', () => {
    expect(isBucketInRange('2026-08-10', range)).toBe(true);
    expect(isBucketInRange('2026-08-16T23:00', range)).toBe(true);
    expect(isBucketInRange('2026-08-09', range)).toBe(false);
    expect(isBucketInRange('2026-08-17', range)).toBe(false);
    expect(isBucketInRange('2026-08-17')).toBe(true);
  });

  it('keeps only the selected days for the summary strip', () => {
    expect(
      rowsInRange(
        [
          { bucket: '2026-08-09', count: 1, level: 1 },
          { bucket: '2026-08-12', count: 2, level: 1 },
        ],
        range,
      ),
    ).toEqual([{ bucket: '2026-08-12', count: 2, level: 1 }]);
  });

  it('shifts out-of-range days onto the dimmed half of the palette', () => {
    expect(
      markActivityRange(
        [
          { bucket: '2026-08-09', count: 5, level: 2 },
          { bucket: '2026-08-12', count: 9, level: 4 },
        ],
        range,
      ),
    ).toEqual([
      { count: 5, date: '2026-08-09', level: 2 + OUT_OF_RANGE_LEVEL_OFFSET },
      { count: 9, date: '2026-08-12', level: 4 },
    ]);
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
