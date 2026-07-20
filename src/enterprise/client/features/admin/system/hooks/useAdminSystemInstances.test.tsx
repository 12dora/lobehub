// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminSystemInstanceRevisions,
  AdminSystemService,
} from '@/enterprise/client/services/adminSystem';

import { useAdminSystemInstances } from './useAdminSystem';

type InstancesKeyLoader = (
  index: number,
  previous: AdminSystemInstanceRevisions | null,
) => readonly [string, { cursor?: string; limit?: number } | undefined] | null;

const mocks = vi.hoisted(() => ({
  getKey: null as InstancesKeyLoader | null,
  infinite: {
    data: [] as AdminSystemInstanceRevisions[] | undefined,
    error: undefined as Error | undefined,
    isValidating: false,
    mutate: vi.fn(),
    setSize: vi.fn(),
    size: 1,
  },
}));

vi.mock('swr/infinite', () => ({
  default: (getKey: InstancesKeyLoader) => {
    mocks.getKey = getKey;
    return mocks.infinite;
  },
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: vi.fn(),
}));

const instance = (
  instanceId: `pinst_${string}`,
): AdminSystemInstanceRevisions['items'][number] => ({
  domains: [
    {
      domain: 'settings',
      lastErrorCategory: null,
      loadedAt: new Date('2026-07-20T00:00:01.000Z'),
      loadedToken: { kind: 'revision', value: 1 },
      loadMode: 'process_cached',
      source: 'database',
      status: 'converged',
    },
  ],
  fresh: true,
  instanceId,
  instanceKind: 'platform',
  lagging: false,
  lastHeartbeatAt: new Date('2026-07-20T00:00:02.000Z'),
  pendingRestart: false,
  startedAt: new Date('2026-07-20T00:00:00.000Z'),
});

const page = (
  items: AdminSystemInstanceRevisions['items'],
  nextCursor: string | null,
): AdminSystemInstanceRevisions => ({
  domains: [],
  items,
  nextCursor,
  snapshotAt: new Date('2026-07-20T00:00:03.000Z'),
});

const service: AdminSystemService = {
  cancelJob: vi.fn(),
  getInstanceRevisions: vi.fn(),
  getJobs: vi.fn(),
  getStatus: vi.fn(),
  retryJob: vi.fn(),
};

describe('useAdminSystemInstances', () => {
  beforeEach(() => {
    mocks.infinite.data = [];
    mocks.infinite.error = undefined;
    mocks.infinite.isValidating = false;
    mocks.infinite.mutate.mockReset().mockResolvedValue(mocks.infinite.data);
    mocks.infinite.setSize.mockReset();
    mocks.infinite.size = 1;
    mocks.getKey = null;
  });

  it('follows the server cursor and stops after the terminal page', () => {
    renderHook(() => useAdminSystemInstances(true, service, { limit: 20 }));
    const first = page([instance(`pinst_${'a'.repeat(48)}`)], 'next-page');
    const last = page([instance(`pinst_${'b'.repeat(48)}`)], null);

    expect(mocks.getKey?.(0, null)).toEqual([
      'admin.system.getInstanceRevisions',
      { cursor: undefined, limit: 20 },
    ]);
    expect(mocks.getKey?.(1, first)).toEqual([
      'admin.system.getInstanceRevisions',
      { cursor: 'next-page', limit: 20 },
    ]);
    expect(mocks.getKey?.(2, last)).toBeNull();
  });

  it('deduplicates accumulated rows and exposes a later-page failure separately', () => {
    const repeated = instance(`pinst_${'a'.repeat(48)}`);
    mocks.infinite.data = [
      page([repeated], 'next-page'),
      page([repeated, instance(`pinst_${'b'.repeat(48)}`)], null),
    ];
    mocks.infinite.error = new Error('page unavailable');
    mocks.infinite.size = 3;

    const { result } = renderHook(() => useAdminSystemInstances(true, service));

    expect(result.current.data?.items.map(({ instanceId }) => instanceId)).toEqual([
      repeated.instanceId,
      `pinst_${'b'.repeat(48)}`,
    ]);
    expect(result.current.loadMoreError).toBe(true);
    expect(result.current.initialError).toBeUndefined();
    expect(result.current.backgroundError).toBeUndefined();
  });

  it('does not fetch or expose pagination without read permission', () => {
    const { result } = renderHook(() => useAdminSystemInstances(false, service));

    expect(mocks.getKey?.(0, null)).toBeNull();
    expect(result.current.hasMore).toBe(false);
  });

  it('does not expose load-more before an initial failure has settled', () => {
    mocks.infinite.data = undefined;
    mocks.infinite.error = new Error('initial unavailable');

    const { result } = renderHook(() => useAdminSystemInstances(true, service));

    expect(result.current.initialError).toBeInstanceOf(Error);
    expect(result.current.hasMore).toBe(false);
  });
});
