import { describe, expect, it } from 'vitest';

import { currentMonthKey, isEmptyRank, isEmptyTokenTrend, overviewWindowStartDate } from './utils';

describe('overviewWindowStartDate', () => {
  it('returnsExactlyThirtyCalendarDaysIncludingToday', () => {
    const now = new Date('2026-07-22T15:30:00.000Z');
    // Inclusive window: 2026-06-23 … 2026-07-22 = 30 calendar days.
    expect(overviewWindowStartDate(30, now)).toBe('2026-06-23');
    // Inclusive 7-day window: 2026-07-16 … 2026-07-22.
    expect(overviewWindowStartDate(7, now)).toBe('2026-07-16');
  });
});

describe('currentMonthKey', () => {
  it('formats year-month', () => {
    expect(currentMonthKey(new Date('2026-07-22T00:00:00.000Z'))).toBe('2026-07');
  });
});

describe('isEmptyTokenTrend', () => {
  it('is empty when missing or all zeros', () => {
    expect(isEmptyTokenTrend(undefined)).toBe(true);
    expect(isEmptyTokenTrend([])).toBe(true);
    expect(isEmptyTokenTrend([{ day: 'a', tokens: 0 }])).toBe(true);
    expect(isEmptyTokenTrend([{ day: 'a', tokens: 1 }])).toBe(false);
  });
});

describe('isEmptyRank', () => {
  it('is empty when no rows or zero counts', () => {
    expect(isEmptyRank(undefined)).toBe(true);
    expect(isEmptyRank([])).toBe(true);
    expect(isEmptyRank([{ count: 0 }, { count: null }])).toBe(true);
    expect(isEmptyRank([{ count: 3 }])).toBe(false);
  });
});
