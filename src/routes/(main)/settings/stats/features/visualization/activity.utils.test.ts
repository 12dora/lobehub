import { describe, expect, it } from 'vitest';

import {
  activityBucketDay,
  activitySpansDays,
  type CalendarBlockMetrics,
  currentDayInZone,
  formatActivityBucketLabel,
  isBucketInRange,
  isTerminalDayCurrent,
  markActivityRange,
  OUT_OF_RANGE_LEVEL_OFFSET,
  resolveActivityView,
  resolveCalendarBlockMetrics,
  resolveCalendarColumns,
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
  /** The grid width the chart draws from these metrics — its intrinsic SVG width. */
  const gridWidth = (columns: number, { blockMargin, blockSize }: CalendarBlockMetrics) =>
    columns * blockSize + (columns - 1) * blockMargin;

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

  it('fills the measured width exactly, at every card width and column count', () => {
    // The admin overview row, the statistics column, a phone — and the 52/53/54 columns
    // the trailing calendar, a widened custom range and the loading skeleton produce.
    for (const width of [1600, 1300, 900, 840, 700, 520, 400, 360, 320, 300, 100]) {
      for (const columns of [52, 53, 54]) {
        for (const mobile of [false, true]) {
          const metrics = resolveCalendarBlockMetrics(width, mobile, columns);
          // Neither a blank strip on the right nor a column drawn past the card
          // (the slack is float arithmetic, not layout).
          expect(gridWidth(columns, metrics)).toBeCloseTo(width, 6);
          expect(gridWidth(columns, metrics)).toBeLessThanOrEqual(width + 1e-9);
        }
      }
    }
  });

  it('grows the block past the year-view size rather than leaving the right blank', () => {
    // The old 14px ceiling left ~370px of dead space on a full-row admin card.
    const metrics = resolveCalendarBlockMetrics(1300, false, 52);
    expect(metrics.blockSize).toBeGreaterThan(14);
    expect(gridWidth(52, metrics)).toBeCloseTo(1300, 6);
  });

  it('sizes by the real column count instead of reserving a week that is never drawn', () => {
    expect(resolveCalendarBlockMetrics(1300, false, 52).blockSize).toBeGreaterThan(
      resolveCalendarBlockMetrics(1300, false, 53).blockSize,
    );
  });

  it('steps the gap down as the card narrows, so the block keeps the room', () => {
    // 52 columns × 6px + 51 gaps × 4px = 516px is the last width the roomy gap can hold.
    expect(resolveCalendarBlockMetrics(516, false, 52)).toMatchObject({
      blockMargin: 4,
      blockSize: 6,
    });
    expect(resolveCalendarBlockMetrics(515, false, 52)).toMatchObject({
      blockMargin: 2,
      blockRadius: 1,
    });
    // 53 columns × 4px + 52 gaps × 2px = 316px is the last width the 2px gap can hold;
    // below it the gap is a hairline rather than the grid running past the card.
    expect(resolveCalendarBlockMetrics(316, false, 53)).toMatchObject({
      blockMargin: 2,
      blockSize: 4,
    });
    expect(resolveCalendarBlockMetrics(315, false, 53)).toMatchObject({ blockMargin: 1 });
    // A 54-column loading year on the same narrow card: still no overflow.
    expect(resolveCalendarBlockMetrics(320, false, 54)).toMatchObject({ blockMargin: 1 });
    expect(gridWidth(54, resolveCalendarBlockMetrics(320, false, 54))).toBeCloseTo(320, 6);
  });

  it('gives the gap up altogether rather than draw past an impossibly narrow card', () => {
    // 52 columns in 100px is not a chart any more, but it must still stay inside.
    const cramped = resolveCalendarBlockMetrics(100, false, 52);
    expect(cramped).toMatchObject({ blockMargin: 0, blockRadius: 0 });
    expect(cramped.blockSize).toBeGreaterThan(0);
    expect(gridWidth(52, cramped)).toBeCloseTo(100, 6);
  });

  it('scales down on mobile, where the card is a phone wide', () => {
    expect(resolveCalendarBlockMetrics(undefined, true)).toEqual({
      blockMargin: 3,
      blockRadius: 2,
      blockSize: 6,
    });
    // A phone-wide card still fills its width — with the tight gap, as it must.
    const phone = resolveCalendarBlockMetrics(360, true, 52);
    expect(phone.blockMargin).toBe(2);
    expect(gridWidth(52, phone)).toBeCloseTo(360, 6);
  });
});

describe('resolveCalendarColumns', () => {
  /** `days` consecutive `YYYY-MM-DD` keys from `start`, as the chart reads them. */
  const dayKeys = (start: string, days: number) => {
    const [year, month, day] = start.split('-').map(Number);
    return Array.from({ length: days }, (_, index) => {
      const date = new Date(year, month - 1, day + index);
      return {
        date: [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0'),
        ].join('-'),
      };
    });
  };

  it('counts 52 columns for the Sunday-aligned trailing calendar', () => {
    // What resolveCalendarWindow yields: Sunday 2025-08-24 through Sunday 2026-08-16.
    expect(resolveCalendarColumns(dayKeys('2025-08-24', 358))).toBe(52);
  });

  it('counts the extra columns a widened custom range really draws', () => {
    // A 366-day range starting on a Saturday: one padded day, then 52 more weeks.
    expect(resolveCalendarColumns(dayKeys('2025-08-16', 366))).toBe(54);
    expect(resolveCalendarColumns(dayKeys('2025-08-22', 360))).toBe(53);
  });

  it('pads the first week to its Sunday, as the chart does', () => {
    // Wednesday 2026-08-12 through Sunday 2026-08-16: two columns, not one.
    expect(resolveCalendarColumns(dayKeys('2026-08-12', 5))).toBe(2);
    expect(resolveCalendarColumns(dayKeys('2026-08-16', 1))).toBe(1);
  });

  it('pads to whatever weekday the chart was told to start its columns on', () => {
    // The chart cuts the same series into different columns per weekStart, and the
    // grid is sized column by column — reading it as Sunday-only overflows by one.
    // Sunday 2025-08-24 → Monday 2026-08-17: 52 Sunday columns, 53 Monday ones.
    const trailing = dayKeys('2025-08-24', 359);
    expect(resolveCalendarColumns(trailing)).toBe(52);
    expect(resolveCalendarColumns(trailing, { weekStart: 1 })).toBe(53);
    // Sunday + Monday share a Sunday-started column but straddle a Monday-started one.
    expect(resolveCalendarColumns(dayKeys('2026-08-16', 2))).toBe(1);
    expect(resolveCalendarColumns(dayKeys('2026-08-16', 2), { weekStart: 1 })).toBe(2);
  });

  it('falls back to the year-long skeleton the chart draws while loading', () => {
    // 2026 opens on a Thursday: 4 padded days + 365 = 53 columns.
    expect(resolveCalendarColumns(undefined, { now: new Date(2026, 0, 15) })).toBe(53);
    expect(resolveCalendarColumns([], { now: new Date(2026, 5, 1) })).toBe(53);
    // A leap year that opens on a Saturday needs one more.
    expect(resolveCalendarColumns([], { now: new Date(2028, 5, 1) })).toBe(54);
    // The skeleton is cut by weekStart too: Thursday is 2 days into a Tuesday week.
    expect(resolveCalendarColumns([], { now: new Date(2026, 5, 1), weekStart: 2 })).toBe(53);
  });

  it('falls back rather than trusting a series it cannot read', () => {
    expect(resolveCalendarColumns([{ date: 'whenever' }], { now: new Date(2026, 5, 1) })).toBe(53);
    expect(
      resolveCalendarColumns([{ date: '2026-08-16' }, { date: '2026-08-10' }], {
        now: new Date(2026, 5, 1),
      }),
    ).toBe(53);
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
