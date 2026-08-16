// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useModerationTimeRange } from './useModerationTimeRange';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('useModerationTimeRange', () => {
  it('defaults to the last 7 days, not the 30-day admin default', () => {
    const { result } = renderHook(() => useModerationTimeRange());
    expect(result.current.rangeKey).toBe('7d');
    const span =
      new Date(result.current.range.endAt).getTime() -
      new Date(result.current.range.startAt).getTime();
    expect(span).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(span).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it('seeds the custom picker from the visible window instead of resolving back to a preset', () => {
    const { result } = renderHook(() => useModerationTimeRange());
    act(() => result.current.setRangeKey('custom'));
    expect(result.current.rangeKey).toBe('custom');
    expect(result.current.customFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.current.customTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to the default preset when the custom window is unusable', () => {
    const { result } = renderHook(() => useModerationTimeRange());
    act(() => result.current.setCustomRange('2026-02-31', undefined));
    expect(result.current.rangeKey).toBe('30d');
  });

  it('drops the custom days when a preset is picked again', () => {
    const { result } = renderHook(() => useModerationTimeRange());
    act(() => result.current.setCustomRange('2026-08-01', '2026-08-05'));
    expect(result.current.rangeKey).toBe('custom');
    act(() => result.current.setRangeKey('24h'));
    expect(result.current.rangeKey).toBe('24h');
    expect(result.current.customFrom).toBeUndefined();
  });
});
