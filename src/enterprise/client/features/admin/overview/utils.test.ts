import { describe, expect, it } from 'vitest';

import type { UsageLog } from '@/types/usage/usageRecord';

import {
  currentMonthKey,
  isEmptyHeatmap,
  isEmptyRank,
  isEmptyTokenTrend,
  overviewWindowStartDate,
  toDailyTokenTrend,
} from './utils';

describe('overviewWindowStartDate', () => {
  it('returns YYYY-MM-DD for N days before the given now', () => {
    const now = new Date('2026-07-22T15:30:00.000Z');
    expect(overviewWindowStartDate(30, now)).toBe('2026-06-22');
    expect(overviewWindowStartDate(7, now)).toBe('2026-07-15');
  });
});

describe('currentMonthKey', () => {
  it('formats year-month', () => {
    expect(currentMonthKey(new Date('2026-07-22T00:00:00.000Z'))).toBe('2026-07');
  });
});

describe('toDailyTokenTrend', () => {
  it('maps logs to day/token points', () => {
    const logs = [
      { day: '2026-07-01', totalTokens: 1200 },
      { day: '2026-07-02', totalTokens: 0 },
      { day: '2026-07-03', totalTokens: undefined },
    ] as unknown as UsageLog[];

    expect(toDailyTokenTrend(logs)).toEqual([
      { day: '2026-07-01', tokens: 1200 },
      { day: '2026-07-02', tokens: 0 },
      { day: '2026-07-03', tokens: 0 },
    ]);
  });

  it('returns empty array for missing input', () => {
    expect(toDailyTokenTrend(undefined)).toEqual([]);
    expect(toDailyTokenTrend(null)).toEqual([]);
    expect(toDailyTokenTrend([])).toEqual([]);
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

describe('isEmptyHeatmap', () => {
  it('is empty when no active levels', () => {
    expect(isEmptyHeatmap(undefined)).toBe(true);
    expect(isEmptyHeatmap([{ level: 0 }, { level: 0 }])).toBe(true);
    expect(isEmptyHeatmap([{ level: 2 }])).toBe(false);
  });
});
