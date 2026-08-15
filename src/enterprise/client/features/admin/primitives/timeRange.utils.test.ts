import dayjs from 'dayjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADMIN_TIME_RANGE_MAX_DAYS,
  ADMIN_TIME_RANGE_MAX_MS,
  formatCustomRangeLabel,
  isAdminTimeRangeDay,
  resolveAdminTimeRange,
} from './timeRange.utils';

/** Fixed instant, interpreted in the runner's local zone (the same zone the UI uses). */
const NOW = new Date('2026-07-22T15:30:00.000Z');

const day = (iso: string) => dayjs(iso).format('YYYY-MM-DD');
const isLocalMidnight = (iso: string) => {
  const d = dayjs(iso);
  return d.hour() === 0 && d.minute() === 0 && d.second() === 0 && d.millisecond() === 0;
};

describe('resolveAdminTimeRange presets', () => {
  it('todayStartsAtLocalMidnightAndEndsNow', () => {
    const range = resolveAdminTimeRange('today', NOW);
    expect(range.key).toBe('today');
    expect(isLocalMidnight(range.startAt)).toBe(true);
    expect(day(range.startAt)).toBe(dayjs(NOW).format('YYYY-MM-DD'));
    expect(range.endAt).toBe(NOW.toISOString());
  });

  it('twentyFourHoursIsAnExactRollingWindow', () => {
    const range = resolveAdminTimeRange('24h', NOW);
    expect(range.endAt).toBe(NOW.toISOString());
    expect(dayjs(range.endAt).diff(dayjs(range.startAt), 'hour')).toBe(24);
    // Rolling window — not snapped to a day boundary.
    expect(isLocalMidnight(range.startAt)).toBe(false);
  });

  it.each([
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const)('%s covers exactly N calendar days including today', (key, days) => {
    const range = resolveAdminTimeRange(key, NOW);
    expect(range.key).toBe(key);
    expect(isLocalMidnight(range.startAt)).toBe(true);
    // Day math goes through dayjs calendar units, so a DST shift inside the window
    // cannot move the local day boundary — assert on local days, not on elapsed hours.
    expect(dayjs(range.endAt).startOf('day').diff(dayjs(range.startAt), 'day') + 1).toBe(days);
  });
});

describe('resolveAdminTimeRange custom', () => {
  it('endsAtTheStartOfTheDayAfterTheInclusiveEndDay', () => {
    const range = resolveAdminTimeRange('custom', NOW, { from: '2026-07-01', to: '2026-07-03' });
    expect(range.key).toBe('custom');
    expect(day(range.startAt)).toBe('2026-07-01');
    expect(isLocalMidnight(range.startAt)).toBe(true);
    // Half-open: the whole of 07-03 is inside the window.
    expect(day(range.endAt)).toBe('2026-07-04');
    expect(isLocalMidnight(range.endAt)).toBe(true);
  });

  it('coversASingleDayWhenFromEqualsTo', () => {
    const range = resolveAdminTimeRange('custom', NOW, { from: '2026-07-01', to: '2026-07-01' });
    expect(dayjs(range.endAt).diff(dayjs(range.startAt), 'day')).toBe(1);
  });

  it('fallsBackToTheDefaultPresetOnMissingInvalidOrInvertedBounds', () => {
    for (const custom of [
      undefined,
      { from: '2026-07-01' },
      { to: '2026-07-03' },
      { from: '', to: '' },
      { from: 'nonsense', to: '2026-07-03' },
      { from: '2026-07-05', to: '2026-07-01' },
    ]) {
      const range = resolveAdminTimeRange('custom', NOW, custom);
      expect(range.key).toBe('30d');
      expect(range.endAt).toBe(NOW.toISOString());
    }
  });

  it('rejectsDaysThatDoNotExistInsteadOfLettingDayjsRollThemOver', () => {
    // dayjs('2026-02-31') is "valid" and silently means 2026-03-03.
    expect(isAdminTimeRangeDay('2026-02-31')).toBe(false);
    expect(isAdminTimeRangeDay('2025-02-29')).toBe(false);
    expect(isAdminTimeRangeDay('2026-13-01')).toBe(false);
    expect(isAdminTimeRangeDay('2026-07-1')).toBe(false);
    expect(isAdminTimeRangeDay('2026-02-28')).toBe(true);
    expect(isAdminTimeRangeDay('2024-02-29')).toBe(true);

    const range = resolveAdminTimeRange('custom', NOW, { from: '2026-02-31', to: '2026-03-05' });
    expect(range.key).toBe('30d');
  });

  it('clampsAWindowWiderThanTheServerCapInsteadOfSendingAnUnacceptedRange', () => {
    const range = resolveAdminTimeRange('custom', NOW, { from: '2020-01-01', to: '2026-07-03' });
    expect(range.key).toBe('custom');
    expect(dayjs(range.endAt).diff(dayjs(range.startAt), 'day')).toBe(ADMIN_TIME_RANGE_MAX_DAYS);
  });
});

describe('custom clamp under DST', () => {
  const originalTz = process.env.TZ;

  // A window ending on the day of a fall-back and starting on the previous one nets
  // +1 hour of elapsed time — the case where a calendar clamp overshoots a wall-clock cap.
  beforeAll(() => {
    process.env.TZ = 'Europe/Berlin';
  });
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  it('staysUnderTheServersAbsoluteElapsedCapEvenWhenDstStretchesTheWindow', () => {
    const range = resolveAdminTimeRange('custom', new Date('2026-10-25T12:00:00.000Z'), {
      from: '2019-01-01',
      to: '2026-10-25',
    });
    const elapsed = dayjs(range.endAt).valueOf() - dayjs(range.startAt).valueOf();

    // The hazard is real here: the clamped window is longer than N × 24h…
    expect(elapsed).toBeGreaterThan(ADMIN_TIME_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000);
    // …yet still inside what the server accepts (it compares elapsed ms, not calendar days).
    expect(elapsed).toBeLessThanOrEqual(ADMIN_TIME_RANGE_MAX_MS);
    // Clamping to 366 calendar days instead would have been rejected — that is why the
    // client clamp is one day tighter than the server cap.
    const naive = dayjs(range.endAt).valueOf() - dayjs(range.endAt).subtract(366, 'day').valueOf();
    expect(naive).toBeGreaterThan(ADMIN_TIME_RANGE_MAX_MS);
  });
});

describe('formatCustomRangeLabel', () => {
  it('showsTheInclusiveEndDayRatherThanTheExclusiveBound', () => {
    const range = resolveAdminTimeRange('custom', NOW, { from: '2026-07-01', to: '2026-07-03' });
    expect(formatCustomRangeLabel(range)).toBe('7/1 – 7/3');
  });
});
