import { describe, expect, it } from 'vitest';

import { isEmptyRank, isEmptyTokenTrend } from './utils';

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
