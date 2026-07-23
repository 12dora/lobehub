// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminAgentListPagination } from './useAdminAgents';

const infinite = vi.hoisted(() => ({
  impl: vi.fn(),
  captured: { getKey: undefined as unknown as (i: number, p: unknown) => unknown },
}));

vi.mock('swr/infinite', () => ({
  default: (getKey: (i: number, p: unknown) => unknown, _fetcher: unknown, _config: unknown) => {
    infinite.captured.getKey = getKey;
    return infinite.impl();
  },
}));

const item = (id: string) => ({
  assignmentCount: 0,
  displayName: id,
  identity: { agentKey: id, id, status: 'draft' },
  publishedVersion: null,
});

describe('useAdminAgentListPagination', () => {
  beforeEach(() => infinite.impl.mockReset());

  it('dedupes accumulated pages and reports the end of the list', () => {
    infinite.impl.mockReturnValue({
      data: [
        { items: [item('a'), item('b')], nextCursor: 'p2' },
        { items: [item('b'), item('c')], nextCursor: null },
      ],
      error: undefined,
      isValidating: false,
      mutate: vi.fn(),
      setSize: vi.fn(),
      size: 2,
    });
    const { result } = renderHook(() => useAdminAgentListPagination({}, true));
    expect(result.current.items.map((i) => i.identity.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.boundaryData?.map((i) => i.identity.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.isEmpty).toBe(false);
    expect(result.current.isLoadingInitial).toBe(false);
    expect(result.current.loadMoreError).toBe(false);
  });

  it('flags more pages and loads them via setSize', () => {
    const setSize = vi.fn();
    infinite.impl.mockReturnValue({
      data: [{ items: [item('a')], nextCursor: 'p2' }],
      error: undefined,
      isValidating: true,
      mutate: vi.fn(),
      setSize,
      size: 2,
    });
    const { result } = renderHook(() => useAdminAgentListPagination({}, true));
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isLoadingMore).toBe(true);
    result.current.loadMore();
    expect(setSize).toHaveBeenCalledWith(expect.any(Function));
  });

  it('treats an undefined data set as the initial load', () => {
    infinite.impl.mockReturnValue({
      data: undefined,
      error: undefined,
      isValidating: true,
      mutate: vi.fn(),
      setSize: vi.fn(),
      size: 1,
    });
    const { result } = renderHook(() => useAdminAgentListPagination({}, true));
    expect(result.current.isLoadingInitial).toBe(true);
    expect(result.current.isEmpty).toBe(false);
    // Not settled yet → AsyncBoundary must see undefined so it renders loading, not empty.
    expect(result.current.boundaryData).toBeUndefined();
  });

  it('returns to initial loading feedback while retrying a first-page error', () => {
    infinite.impl.mockReturnValue({
      data: undefined,
      error: new Error('offline'),
      isValidating: true,
      mutate: vi.fn(),
      setSize: vi.fn(),
      size: 1,
    });
    const { result } = renderHook(() => useAdminAgentListPagination({}, true));
    expect(result.current.isLoadingInitial).toBe(true);
    expect(result.current.boundaryData).toBeUndefined();
  });

  it('keeps settled content and flags loadMoreError when a later page fails', () => {
    infinite.impl.mockReturnValue({
      data: [{ items: [item('a')], nextCursor: 'p2' }],
      error: new Error('page 2 failed'),
      isValidating: false,
      mutate: vi.fn(),
      setSize: vi.fn(),
      size: 2,
    });
    const { result } = renderHook(() => useAdminAgentListPagination({}, true));
    expect(result.current.boundaryData?.map((i) => i.identity.id)).toEqual(['a']);
    expect(result.current.loadMoreError).toBe(true);
    expect(result.current.isLoadingInitial).toBe(false);
  });

  it('reports empty only after a resolved empty first page', () => {
    infinite.impl.mockReturnValue({
      data: [{ items: [], nextCursor: null }],
      error: undefined,
      isValidating: false,
      mutate: vi.fn(),
      setSize: vi.fn(),
      size: 1,
    });
    const { result } = renderHook(() => useAdminAgentListPagination({}, true));
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.hasMore).toBe(false);
    // Settled empty page → defined (empty) so AsyncBoundary renders the empty state, not loading.
    expect(result.current.boundaryData).toEqual([]);
  });

  it('advances the cursor and stops at the end via getKey', () => {
    infinite.impl.mockReturnValue({
      data: undefined,
      error: undefined,
      isValidating: false,
      mutate: vi.fn(),
      setSize: vi.fn(),
      size: 1,
    });
    renderHook(() => useAdminAgentListPagination({ status: 'draft' }, true));
    const getKey = infinite.captured.getKey;
    expect(getKey(0, null)).toEqual([
      'enterprise.admin.agents.list',
      { status: 'draft' },
      undefined,
    ]);
    expect(getKey(1, { items: [], nextCursor: 'cursor-2' })).toEqual([
      'enterprise.admin.agents.list',
      { status: 'draft' },
      'cursor-2',
    ]);
    // End reached → null key stops further fetching.
    expect(getKey(2, { items: [], nextCursor: null })).toBeNull();
  });

  it('disables all fetching when the caller has no read permission', () => {
    infinite.impl.mockReturnValue({
      data: undefined,
      error: undefined,
      isValidating: false,
      mutate: vi.fn(),
      setSize: vi.fn(),
      size: 0,
    });
    renderHook(() => useAdminAgentListPagination({}, false));
    expect(infinite.captured.getKey(0, null)).toBeNull();
  });

  it('exposes refresh as the bound useSWRInfinite mutate (not a global predicate)', async () => {
    const mutate = vi.fn().mockResolvedValue([{ items: [item('a')], nextCursor: null }]);
    infinite.impl.mockReturnValue({
      data: [{ items: [item('a')], nextCursor: null }],
      error: undefined,
      isValidating: false,
      mutate,
      setSize: vi.fn(),
      size: 1,
    });
    const { result } = renderHook(() => useAdminAgentListPagination({}, true));
    // Same function reference as the infinite hook mutator — list create/delete must call this.
    expect(result.current.refresh).toBe(mutate);
    await result.current.refresh();
    expect(mutate).toHaveBeenCalledOnce();
  });
});
