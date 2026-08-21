import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesTabs } from '@/types/files';

import { useExplorerListData } from './useExplorerListData';

const mocks = vi.hoisted(() => ({
  fileState: {
    hasMore: false,
    queryParams: { category: 'all', parentId: null },
    resourceList: [{ id: 'resource-1', name: 'Report' }],
  },
  globalState: {
    status: {},
  },
  resourceManagerState: {
    sorter: 'createdAt' as const,
    sortType: 'desc' as const,
  },
}));

vi.mock('@/routes/(main)/resource/features/hooks/useCurrentFolderId', () => ({
  useCurrentFolderId: () => null,
}));

vi.mock('@/routes/(main)/resource/features/store', () => ({
  useResourceManagerStore: (selector: (state: typeof mocks.resourceManagerState) => unknown) =>
    selector(mocks.resourceManagerState),
}));

vi.mock('@/routes/(main)/resource/features/store/selectors', () => ({
  sortFileList: (items: unknown[]) => items,
}));

vi.mock('@/store/file', () => ({
  useFileStore: (selector: (state: typeof mocks.fileState) => unknown) => selector(mocks.fileState),
}));

vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (state: typeof mocks.globalState) => unknown) =>
    selector(mocks.globalState),
}));

describe('useExplorerListData', () => {
  beforeEach(() => {
    mocks.fileState = {
      hasMore: false,
      queryParams: { category: 'all', parentId: null },
      resourceList: [{ id: 'resource-1', name: 'Report' }],
    };
  });

  it('keeps the previous rows while navigating instead of flashing a skeleton', () => {
    const { result } = renderHook(() =>
      useExplorerListData({
        isLoading: false,
        isValidating: false,
        queryParams: { category: FilesTabs.Documents, parentId: null },
      }),
    );

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.isRefreshing).toBe(true);
    expect(result.current.data).toHaveLength(1);
  });

  it('shows the skeleton while navigating with nothing left to render', () => {
    mocks.fileState.resourceList = [];

    const { result } = renderHook(() =>
      useExplorerListData({
        isLoading: false,
        isValidating: false,
        queryParams: { category: FilesTabs.Documents, parentId: null },
      }),
    );

    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.isRefreshing).toBe(false);
  });

  it('does not replace a populated list with a skeleton while revalidating', () => {
    const { result } = renderHook(() =>
      useExplorerListData({
        isLoading: true,
        isValidating: true,
        queryParams: { category: FilesTabs.All, parentId: null },
      }),
    );

    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
  });
});
