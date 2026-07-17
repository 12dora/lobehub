// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AdminAgentDetailOutput } from './types';
import { useRefreshLock } from './useRefreshLock';

describe('useRefreshLock', () => {
  it('stays unlocked after a successful post-commit refresh', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRefreshLock(mutate as never));

    await act(async () => {
      await result.current.syncAfterCommit();
    });
    expect(result.current.refreshFailed).toBe(false);
    expect(result.current.isLocked()).toBe(false);
  });

  it('locks (fail-closed) when the post-commit refresh fails, then unlocks on retry', async () => {
    const mutate = vi
      .fn<() => Promise<AdminAgentDetailOutput | undefined>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useRefreshLock(mutate as never));

    await act(async () => {
      await result.current.syncAfterCommit();
    });
    expect(result.current.refreshFailed).toBe(true);
    expect(result.current.isLocked()).toBe(true);

    await act(async () => {
      await result.current.retryRefresh();
    });
    expect(result.current.refreshFailed).toBe(false);
    expect(result.current.isLocked()).toBe(false);
  });
});
