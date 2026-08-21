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

  it('resets the cursor stack when the page size changes', () => {
    const { result } = renderHook(() => useCursorPagination());

    act(() => result.current.onNext('cursor-1'));
    expect(result.current.hasPrevious).toBe(true);

    act(() => result.current.onPageSizeChange(50));
    expect(result.current.limit).toBe(50);
    expect(result.current.hasPrevious).toBe(false);
    expect(result.current.currentCursor).toBeNull();
  });
});
