import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminModulesService,
  AdminModulesState,
} from '@/enterprise/client/services/adminModules';

import {
  MODULE_RESTART_POLL_MS,
  MODULE_RESTART_TIMEOUT_MS,
  useModuleRestart,
} from './useAdminModules';

vi.mock('@/libs/swr', () => ({ mutate: vi.fn(), useClientDataSWR: vi.fn() }));

const state = (pendingRestart: string[]) => ({ pendingRestart }) as unknown as AdminModulesState;

const setVisibility = (visibility: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  document.dispatchEvent(new Event('visibilitychange'));
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

const createService = (get: AdminModulesService['get']): AdminModulesService => ({
  get,
  requestRestart: vi.fn().mockResolvedValue({}),
  update: vi.fn(),
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  setVisibility('visible');
  vi.useRealTimers();
});

describe('useModuleRestart', () => {
  it('polls until the instance reports no pending restart', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(state(['ai']))
      .mockResolvedValueOnce(state([]));
    const { result } = renderHook(() => useModuleRestart(createService(get)));

    await act(async () => {
      await result.current.request();
    });
    expect(result.current.phase).toBe('accepted');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODULE_RESTART_POLL_MS * 2);
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe('activated');
  });

  it('parks while the tab is hidden and resumes the moment it comes back', async () => {
    const get = vi.fn().mockResolvedValue(state([]));
    const { result } = renderHook(() => useModuleRestart(createService(get)));

    await act(async () => {
      await result.current.request();
    });
    act(() => setVisibility('hidden'));

    // A background tab asks nothing at all, however long the restart takes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODULE_RESTART_POLL_MS * 20);
    });
    expect(get).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('accepted');

    // Coming back must pick up the converged state immediately, not one cadence later.
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(get).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('activated');
  });

  it('parks instead of acting when the tab leaves while a request is in flight', async () => {
    const inFlight = deferred<AdminModulesState>();
    const get = vi.fn().mockReturnValueOnce(inFlight.promise).mockResolvedValue(state([]));
    const { result } = renderHook(() => useModuleRestart(createService(get)));

    await act(async () => {
      await result.current.request();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODULE_RESTART_POLL_MS);
    });
    expect(get).toHaveBeenCalledOnce();

    // Tab leaves, THEN the answer lands: neither the cache refresh nor the next tick belongs to
    // a tab nobody is looking at.
    act(() => setVisibility('hidden'));
    await act(async () => {
      inFlight.resolve(state([]));
      await vi.advanceTimersByTimeAsync(MODULE_RESTART_POLL_MS * 10);
    });
    expect(get).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('accepted');

    // …and the answer is re-asked for, once, on the way back.
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe('activated');
  });

  it('does not burn the convergence budget while nobody is watching', async () => {
    const get = vi.fn().mockResolvedValue(state([]));
    const { result } = renderHook(() => useModuleRestart(createService(get)));

    await act(async () => {
      await result.current.request();
    });
    act(() => setVisibility('hidden'));

    // Longer than the whole budget: without the pause the tab would come back to "failed".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODULE_RESTART_TIMEOUT_MS * 2);
    });
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.phase).toBe('activated');
  });

  it('still fails when the budget runs out with the tab in front', async () => {
    const get = vi.fn().mockResolvedValue(state(['ai']));
    const { result } = renderHook(() => useModuleRestart(createService(get)));

    await act(async () => {
      await result.current.request();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODULE_RESTART_TIMEOUT_MS + MODULE_RESTART_POLL_MS);
    });

    expect(result.current.phase).toBe('failed');
  });

  it('drops a parked resume listener on unmount', async () => {
    const get = vi.fn().mockResolvedValue(state([]));
    const { result, unmount } = renderHook(() => useModuleRestart(createService(get)));

    await act(async () => {
      await result.current.request();
    });
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODULE_RESTART_POLL_MS);
    });

    unmount();
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(MODULE_RESTART_POLL_MS);
    });

    expect(get).not.toHaveBeenCalled();
  });
});
