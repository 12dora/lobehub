/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_GLOBAL_STATS_SCOPE,
  personalStatsDataSource,
  StatsDataSourceProvider,
} from './StatsDataSource';
import {
  isStatsFilterActive,
  type StatsFilter,
  statsFilterKey,
  statsFilterParams,
  StatsFilterProvider,
  statsFilterUsageParams,
  useStatsSwrKey,
} from './StatsFilter';

const RANGE: StatsFilter = {
  endAt: '2026-07-22T15:30:00.000Z',
  rangeLabel: 'Last 7 days',
  startAt: '2026-07-16T00:00:00.000Z',
};

describe('stats filter predicates', () => {
  it('treatsALabelOnlyFilterAsInactiveSoNoQueryChanges', () => {
    expect(isStatsFilterActive({})).toBe(false);
    expect(isStatsFilterActive({ rangeLabel: 'Last 7 days' })).toBe(false);
    expect(isStatsFilterActive(RANGE)).toBe(true);
    expect(isStatsFilterActive({ userId: 'u1' })).toBe(true);
  });

  it('passesNoParamsAtAllWhenInactiveSoLegacyCallSitesAreUnchanged', () => {
    expect(statsFilterParams({})).toBeUndefined();
    expect(statsFilterUsageParams({}, '2026-07')).toBe('2026-07');
    expect(statsFilterKey({})).toEqual([]);
  });

  it('replacesTheMonthKeyWithTheExplicitWindowWhenActive', () => {
    expect(statsFilterUsageParams({ ...RANGE, userId: 'u1' }, '2026-07')).toEqual({
      endAt: RANGE.endAt,
      startAt: RANGE.startAt,
      userId: 'u1',
    });
  });
});

describe('useStatsSwrKey', () => {
  it('keepsPersonalKeysByteIdenticalWithoutAProvider', () => {
    const key = ['stats:messages'] as const;
    const { result } = renderHook(() => useStatsSwrKey(key));
    expect(result.current).toBe(key);
  });

  it('appendsScopeAndWindowSoEachRangeGetsItsOwnCacheEntry', () => {
    const admin = { ...personalStatsDataSource, scopeKey: ADMIN_GLOBAL_STATS_SCOPE };
    const { result } = renderHook(() => useStatsSwrKey(['stats:messages']), {
      wrapper: ({ children }) => (
        <StatsDataSourceProvider value={admin}>
          <StatsFilterProvider value={{ ...RANGE, userId: 'u1' }}>{children}</StatsFilterProvider>
        </StatsDataSourceProvider>
      ),
    });
    expect(result.current).toEqual([
      'stats:messages',
      ADMIN_GLOBAL_STATS_SCOPE,
      RANGE.startAt,
      RANGE.endAt,
      'u1',
    ]);
  });
});
