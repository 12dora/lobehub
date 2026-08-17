// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminSystemJob,
  AdminSystemJobs,
  AdminSystemService,
} from '@/enterprise/client/services/adminSystem';

import { useAdminSystemJobMutations, useAdminSystemJobs } from './useAdminSystem';

interface PollConfig {
  onSuccess?: (incoming: AdminSystemJobs) => void;
  refreshInterval?: number;
}

interface PollCall {
  config: PollConfig;
  key: readonly [string, number] | null;
}

type JobsKeyLoader = (
  index: number,
  previous: AdminSystemJobs | null,
) => readonly [string, { cursor?: string; limit: number }] | null;

const mocks = vi.hoisted(() => ({
  getKey: null as JobsKeyLoader | null,
  infinite: {
    data: [] as AdminSystemJobs[] | undefined,
    error: undefined as Error | undefined,
    isValidating: false,
    mutate: vi.fn(),
    setSize: vi.fn(),
    size: 1,
  },
  pollCalls: [] as PollCall[],
}));

vi.mock('swr/infinite', () => ({
  default: (getKey: JobsKeyLoader) => {
    mocks.getKey = getKey;
    return mocks.infinite;
  },
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (
    key: readonly [string, number] | null,
    _fetcher: () => Promise<AdminSystemJobs>,
    config: PollConfig,
  ) => {
    mocks.pollCalls.push({ config, key });
    return { error: undefined };
  },
}));

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  withAdminReauthRetry: (operation: () => Promise<AdminSystemJob>) => operation(),
}));

const job = (overrides: Partial<AdminSystemJob> = {}): AdminSystemJob => ({
  attempt: 1,
  canCancel: true,
  canRetry: false,
  createdAt: new Date('2026-07-20T00:00:00.000Z'),
  errorCategory: null,
  failedCount: 0,
  finishedAt: null,
  jobId: 'pjob_0000000000000001',
  kind: 'agent_rollout',
  maxAttempts: 3,
  progress: { done: 0, total: 1 },
  revision: 1,
  startedAt: new Date('2026-07-20T00:00:01.000Z'),
  status: 'running',
  typeId: 'platform.agent.rollout.v1',
  updatedAt: new Date('2026-07-20T00:00:02.000Z'),
  ...overrides,
});

const page = (items: AdminSystemJob[], nextCursor: string | null = null): AdminSystemJobs => ({
  items,
  nextCursor,
});

const service = (overrides: Partial<AdminSystemService> = {}): AdminSystemService => ({
  cancelJob: vi.fn(),
  getInstanceRevisions: vi.fn(),
  getJobs: vi.fn(),
  getStatus: vi.fn(),
  retryJob: vi.fn(),
  ...overrides,
});

describe('useAdminSystemJobs polling authority', () => {
  beforeEach(() => {
    mocks.infinite.data = [page([job({ status: 'succeeded' })])];
    mocks.infinite.error = undefined;
    mocks.infinite.isValidating = false;
    mocks.infinite.size = 1;
    mocks.infinite.mutate.mockReset().mockResolvedValue(mocks.infinite.data);
    mocks.infinite.setSize.mockReset();
    mocks.pollCalls.length = 0;
    mocks.getKey = null;
  });

  it('polls when the aggregate reports active work even if the first page is terminal', async () => {
    const refreshAuthority = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ activeCount }) =>
        useAdminSystemJobs(true, service(), {
          authoritativeActiveCount: activeCount,
          refreshAuthority,
        }),
      { initialProps: { activeCount: 2 } },
    );

    const activeCall = mocks.pollCalls.at(-1)!;
    expect(activeCall.key).toEqual(['admin.system.getJobs.poll', 50]);
    expect(activeCall.config.refreshInterval).toBe(3000);

    await act(async () => {
      activeCall.config.onSuccess?.(page([job({ status: 'succeeded' })]));
      await Promise.resolve();
    });
    expect(refreshAuthority).toHaveBeenCalledTimes(1);

    rerender({ activeCount: 0 });
    const stoppedCall = mocks.pollCalls.at(-1)!;
    expect(stoppedCall.key).toBeNull();
    expect(stoppedCall.config.refreshInterval).toBe(0);
  });

  it('stops the active-job poll while the tab is hidden', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      renderHook(() =>
        useAdminSystemJobs(true, service(), {
          authoritativeActiveCount: 2,
          refreshAuthority: vi.fn().mockResolvedValue(undefined),
        }),
      );

      // The key stays live (the list still renders); only the 3s cadence — and the authority
      // refresh it drags along — goes quiet until the operator comes back.
      expect(mocks.pollCalls.at(-1)?.key).toEqual(['admin.system.getJobs.poll', 50]);
      expect(mocks.pollCalls.at(-1)?.config.refreshInterval).toBe(0);
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    }
  });

  it('uses visible active rows only while the aggregate is unavailable', () => {
    mocks.infinite.data = [page([job({ status: 'running' })])];
    renderHook(() =>
      useAdminSystemJobs(true, service(), {
        authoritativeActiveCount: null,
        refreshAuthority: vi.fn().mockResolvedValue(undefined),
      }),
    );

    expect(mocks.pollCalls.at(-1)?.key).toEqual(['admin.system.getJobs.poll', 50]);
  });

  it('clears a staged banner when a later poll matches the visible first page', async () => {
    const { result } = renderHook(() =>
      useAdminSystemJobs(true, service(), {
        authoritativeActiveCount: 1,
        refreshAuthority: vi.fn().mockResolvedValue(undefined),
      }),
    );
    const pollCall = mocks.pollCalls.at(-1)!;

    await act(async () => {
      pollCall.config.onSuccess?.(page([job({ progress: { done: 1, total: 1 } })]));
    });
    expect(result.current.hasStagedUpdate).toBe(true);

    await act(async () => {
      pollCall.config.onSuccess?.(mocks.infinite.data![0]);
    });
    expect(result.current.hasStagedUpdate).toBe(false);
  });

  it('returns null list and poll keys without read permission', () => {
    renderHook(() =>
      useAdminSystemJobs(false, service(), {
        authoritativeActiveCount: 1,
        refreshAuthority: vi.fn().mockResolvedValue(undefined),
      }),
    );

    expect(mocks.getKey?.(0, null)).toBeNull();
    expect(mocks.pollCalls.at(-1)?.key).toBeNull();
  });

  it('reports a failed requested page separately from background revalidation', () => {
    mocks.infinite.error = new Error('page unavailable');
    mocks.infinite.size = 2;
    const { rerender, result } = renderHook(() =>
      useAdminSystemJobs(true, service(), {
        authoritativeActiveCount: 0,
        refreshAuthority: vi.fn().mockResolvedValue(undefined),
      }),
    );

    expect(result.current.loadMoreError).toBe(true);
    expect(result.current.backgroundError).toBeUndefined();

    mocks.infinite.size = 1;
    rerender();
    expect(result.current.loadMoreError).toBe(false);
    expect(result.current.backgroundError).toBeInstanceOf(Error);
  });

  it('does not offer pagination before the first page has settled', () => {
    mocks.infinite.data = undefined;
    mocks.infinite.error = new Error('initial unavailable');
    const { result } = renderHook(() =>
      useAdminSystemJobs(true, service(), {
        authoritativeActiveCount: 0,
        refreshAuthority: vi.fn().mockResolvedValue(undefined),
      }),
    );

    expect(result.current.initialError).toBeInstanceOf(Error);
    expect(result.current.hasMore).toBe(false);
  });
});

describe('useAdminSystemJobMutations refresh lock', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('succeeds when the mutation response is authoritative even if list pages omit the job', async () => {
    const original = job();
    const committed = job({
      canCancel: false,
      finishedAt: new Date('2026-07-20T00:00:03.000Z'),
      revision: 2,
      status: 'cancelled',
    });
    // Pagination shift: cancelled job no longer on loaded page one.
    const onRefresh = vi
      .fn<() => Promise<AdminSystemJobs[] | undefined>>()
      .mockResolvedValue([page([job({ jobId: 'pjob_0000000000000099' })])]);
    const client = service({ cancelJob: vi.fn().mockResolvedValue(committed) });
    const { result } = renderHook(() =>
      useAdminSystemJobMutations({ authMethod: null, onRefresh, service: client }),
    );

    await act(async () => {
      expect(await result.current.cancel(original)).toBe('succeeded');
    });
    expect(result.current.refreshPendingJobIds).toEqual([]);
  });

  it('locks a committed row when a loaded page still shows a stale CAS snapshot', async () => {
    const original = job();
    const committed = job({
      canCancel: false,
      finishedAt: new Date('2026-07-20T00:00:03.000Z'),
      revision: 2,
      status: 'cancelled',
    });
    const onRefresh = vi
      .fn<() => Promise<AdminSystemJobs[] | undefined>>()
      .mockResolvedValueOnce([page([original])])
      .mockResolvedValueOnce([page([committed])]);
    const client = service({ cancelJob: vi.fn().mockResolvedValue(committed) });
    const { result } = renderHook(() =>
      useAdminSystemJobMutations({ authMethod: null, onRefresh, service: client }),
    );

    await act(async () => {
      expect(await result.current.cancel(original)).toBe('refresh_failed');
    });
    expect(result.current.refreshPendingJobIds).toEqual([original.jobId]);

    await act(async () => {
      expect(await result.current.retryRefresh()).toBe(true);
    });
    expect(result.current.refreshPendingJobIds).toEqual([]);
  });

  it('rejects a duplicate row action while the first request is pending', async () => {
    const original = job();
    const committed = job({ revision: 2, status: 'cancelled' });
    let resolveCancel: (value: AdminSystemJob) => void = () => undefined;
    const pendingCancel = new Promise<AdminSystemJob>((resolve) => {
      resolveCancel = resolve;
    });
    const cancelJob = vi.fn().mockReturnValue(pendingCancel);
    const client = service({ cancelJob });
    const { result } = renderHook(() =>
      useAdminSystemJobMutations({
        authMethod: null,
        onRefresh: vi.fn().mockResolvedValue([page([committed])]),
        service: client,
      }),
    );

    let firstRequest: Promise<string> | undefined;
    act(() => {
      firstRequest = result.current.cancel(original);
    });
    await expect(result.current.cancel(original)).resolves.toBe('failed');
    expect(cancelJob).toHaveBeenCalledTimes(1);

    resolveCancel(committed);
    await act(async () => {
      await firstRequest;
    });
    expect(result.current.busyJobIds).toEqual([]);
  });
});
