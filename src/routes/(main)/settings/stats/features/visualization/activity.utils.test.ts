import { describe, expect, it } from 'vitest';

import {
  activityBucketDay,
  activitySpansDays,
  currentDayInZone,
  formatActivityBucketLabel,
  isTerminalDayCurrent,
  resolveActivityView,
  summarizeActivitySeries,
  toHeatmapActivities,
} from './activity.utils';

describe('resolveActivityView', () => {
  it.each([
    ['today (a few hours)', '2026-08-16T00:00:00.000Z', '2026-08-16T09:30:00.000Z', 'hour'],
    ['24 hours', '2026-08-15T09:30:00.000Z', '2026-08-16T09:30:00.000Z', 'hour'],
    ['just under 48 hours', '2026-08-14T10:00:00.000Z', '2026-08-16T09:00:00.000Z', 'hour'],
    ['exactly 48 hours', '2026-08-14T09:00:00.000Z', '2026-08-16T09:00:00.000Z', 'day'],
    ['7 days', '2026-08-10T00:00:00.000Z', '2026-08-16T09:30:00.000Z', 'day'],
    ['14 days', '2026-08-02T09:30:00.000Z', '2026-08-16T09:30:00.000Z', 'day'],
    ['15 days', '2026-08-01T09:30:00.000Z', '2026-08-16T09:30:00.000Z', 'calendar'],
    ['30 days', '2026-07-18T00:00:00.000Z', '2026-08-16T09:30:00.000Z', 'calendar'],
    ['90 days', '2026-05-19T00:00:00.000Z', '2026-08-16T09:30:00.000Z', 'calendar'],
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

describe('formatActivityBucketLabel', () => {
  it('labels an hour bucket with its wall-clock hour', () => {
    expect(formatActivityBucketLabel('2026-08-16T09:00', 'hour')).toBe('09:00');
  });

  it('labels a day bucket as M/D without zero padding', () => {
    expect(formatActivityBucketLabel('2026-08-06', 'day')).toBe('8/6');
    expect(formatActivityBucketLabel('2026-08-06', 'calendar')).toBe('8/6');
  });

  it('returns the raw bucket when it is not a shape it knows', () => {
    expect(formatActivityBucketLabel('whenever', 'day')).toBe('whenever');
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
