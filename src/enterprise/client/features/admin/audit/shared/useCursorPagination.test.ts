import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_SIZE } from '../../primitives/dataTableChange';
import { AUDIT_DEFAULT_LIST_LIMIT, useCursorPagination } from './useCursorPagination';

describe('useCursorPagination', () => {
  it('starts on the shared admin page size', () => {
    expect(AUDIT_DEFAULT_LIST_LIMIT).toBe(DEFAULT_PAGE_SIZE);

    const { result } = renderHook(() => useCursorPagination());

    expect(result.current.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(result.current.currentCursor).toBeNull();
    expect(result.current.hasPrevious).toBe(false);
  });

  it('honours an explicit initial limit', () => {
    const { result } = renderHook(() => useCursorPagination({ initialLimit: 100 }));

    expect(result.current.limit).toBe(100);
  });

  it('resets the cursor stack — and the page index — when the page size changes', () => {
    const { result } = renderHook(() => useCursorPagination());

    act(() => result.current.onNext('cursor-1'));
    expect(result.current.hasPrevious).toBe(true);

    act(() => result.current.onPageSizeChange(50));
    expect(result.current.limit).toBe(50);
    expect(result.current.hasPrevious).toBe(false);
    expect(result.current.currentCursor).toBeNull();
    expect(result.current.page).toBe(1);
  });

  it('counts the page index from the cursor stack', () => {
    const { result } = renderHook(() => useCursorPagination());

    expect(result.current.page).toBe(1);
    act(() => result.current.onNext('cursor-1'));
    expect(result.current.page).toBe(2);
    act(() => result.current.onNext('cursor-2'));
    expect(result.current.page).toBe(3);
    act(() => result.current.onPrevious());
    expect(result.current.page).toBe(2);
  });

  it('jumps backwards to the exact visited cursor', () => {
    const { result } = renderHook(() => useCursorPagination());

    act(() => result.current.onNext('cursor-1'));
    act(() => result.current.onNext('cursor-2'));
    act(() => result.current.onNext('cursor-3'));
    expect(result.current.page).toBe(4);

    act(() => result.current.onJumpTo(2));
    expect(result.current.page).toBe(2);
    // Page 2 is served by the first cursor the server handed over.
    expect(result.current.currentCursor).toBe('cursor-1');

    act(() => result.current.onJumpTo(1));
    expect(result.current.page).toBe(1);
    expect(result.current.currentCursor).toBeNull();
  });

  it('ignores forward jumps and out-of-range pages — those cursors are unknown', () => {
    const { result } = renderHook(() => useCursorPagination());

    act(() => result.current.onNext('cursor-1'));
    expect(result.current.page).toBe(2);

    act(() => result.current.onJumpTo(3));
    expect(result.current.page).toBe(2);
    expect(result.current.currentCursor).toBe('cursor-1');

    act(() => result.current.onJumpTo(0));
    expect(result.current.page).toBe(2);
    expect(result.current.currentCursor).toBe('cursor-1');
  });
});
