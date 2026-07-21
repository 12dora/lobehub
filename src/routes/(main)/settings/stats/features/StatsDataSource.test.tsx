/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_GLOBAL_STATS_SCOPE,
  PERSONAL_STATS_SCOPE,
  personalStatsDataSource,
  scopeStatsKey,
  StatsDataSourceProvider,
  useStatsDataSource,
} from './StatsDataSource';

describe('scopeStatsKey', () => {
  it('keeps personal keys unchanged', () => {
    const key = ['stats:messages'] as const;
    expect(scopeStatsKey(key, PERSONAL_STATS_SCOPE)).toBe(key);
    expect(scopeStatsKey(key, '')).toEqual(key);
  });

  it('appends admin scope so caches never collide', () => {
    const key = ['stats:messages'] as const;
    expect(scopeStatsKey(key, ADMIN_GLOBAL_STATS_SCOPE)).toEqual([
      'stats:messages',
      ADMIN_GLOBAL_STATS_SCOPE,
    ]);
  });
});

describe('useStatsDataSource', () => {
  it('defaults to personal data source', () => {
    const { result } = renderHook(() => useStatsDataSource());
    expect(result.current.scopeKey).toBe(PERSONAL_STATS_SCOPE);
    expect(result.current).toBe(personalStatsDataSource);
  });

  it('reads injected source from provider', () => {
    const custom = { ...personalStatsDataSource, scopeKey: ADMIN_GLOBAL_STATS_SCOPE };
    const { result } = renderHook(() => useStatsDataSource(), {
      wrapper: ({ children }) => (
        <StatsDataSourceProvider value={custom}>{children}</StatsDataSourceProvider>
      ),
    });
    expect(result.current.scopeKey).toBe(ADMIN_GLOBAL_STATS_SCOPE);
  });
});
