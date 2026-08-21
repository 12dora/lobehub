import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useMasonryViewState } from './useMasonryViewState';

describe('useMasonryViewState', () => {
  it('keeps the previous cards while navigating instead of flashing a skeleton', () => {
    const { result } = renderHook(() =>
      useMasonryViewState({
        dataLength: 4,
        isLoading: false,
        isNavigating: true,
        isValidating: false,
        viewMode: 'masonry',
      }),
    );

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.isMasonryReady).toBe(true);
    expect(result.current.isRefreshing).toBe(true);
  });

  it('shows the skeleton while navigating with nothing left to render', () => {
    const { result } = renderHook(() =>
      useMasonryViewState({
        dataLength: 0,
        isLoading: false,
        isNavigating: true,
        isValidating: false,
        viewMode: 'masonry',
      }),
    );

    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.isMasonryReady).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
  });

  it('shows the skeleton on a cold load', () => {
    const { result } = renderHook(() =>
      useMasonryViewState({
        dataLength: 0,
        isLoading: true,
        isNavigating: false,
        isValidating: false,
        viewMode: 'masonry',
      }),
    );

    expect(result.current.showSkeleton).toBe(true);
  });

  it('does not replace a populated grid with a skeleton while revalidating', () => {
    const { result } = renderHook(() =>
      useMasonryViewState({
        dataLength: 4,
        isLoading: true,
        isNavigating: false,
        isValidating: true,
        viewMode: 'masonry',
      }),
    );

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
  });
});
