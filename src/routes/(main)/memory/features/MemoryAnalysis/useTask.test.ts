import { AsyncTaskStatus } from '@lobechat/types';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useClientDataSWR = vi.fn((..._args: unknown[]) => ({ data: undefined, mutate: vi.fn() }));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (...args: unknown[]) => (useClientDataSWR as any)(...args),
}));

vi.mock('@/services/userMemory/extraction', () => ({
  memoryExtractionService: { getTask: vi.fn() },
}));

const { useMemoryAnalysisAsyncTask } = await import('./useTask');

const refreshInterval = () => {
  const config = useClientDataSWR.mock.calls.at(-1)?.[2] as {
    refreshInterval: (data: unknown) => number;
  };

  return config.refreshInterval;
};

describe('useMemoryAnalysisAsyncTask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useClientDataSWR.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls on a single 5s SWR cadence and schedules no interval of its own', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    renderHook(() => useMemoryAnalysisAsyncTask('task-1'));

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(refreshInterval()({ status: AsyncTaskStatus.Processing })).toBe(5000);
    expect(refreshInterval()({ status: AsyncTaskStatus.Pending })).toBe(5000);
  });

  it('stops polling once the task reaches a terminal status', () => {
    renderHook(() => useMemoryAnalysisAsyncTask('task-1'));

    expect(refreshInterval()({ status: AsyncTaskStatus.Success })).toBe(0);
    expect(refreshInterval()({ status: AsyncTaskStatus.Error })).toBe(0);
    expect(refreshInterval()(undefined)).toBe(0);
  });
});
