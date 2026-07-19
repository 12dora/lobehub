import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IDENTITY_PROVIDER_RESTART_TIMEOUT_MS } from './controller';
import { useIdentityProviderRestartLifecycle } from './useIdentityProviderRestartLifecycle';

const targetIdentityRevision = 'a'.repeat(64);
const pendingStatus = {
  active: { allFreshInstancesActive: false },
  pendingRestart: true,
  restart: { supported: true },
  targetIdentityRevision,
};

afterEach(() => vi.useRealTimers());

describe('useIdentityProviderRestartLifecycle', () => {
  it('keeps pre-accept failure out of polling and retry invokes a real rerun', () => {
    const { result } = renderHook(() =>
      useIdentityProviderRestartLifecycle({ error: null, status: pendingStatus }),
    );
    act(() => result.current.fail());
    expect(result.current.phase).toBe('failed');
    expect(result.current.attempt).toBeNull();

    const rerun = vi.fn();
    act(() => result.current.retry(rerun));
    expect(rerun).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('idle');
    expect(result.current.attempt).toBeNull();
  });

  it('moves only an accepted request to activated after matching convergence', () => {
    const { rerender, result } = renderHook(
      ({ status }) => useIdentityProviderRestartLifecycle({ error: null, status }),
      { initialProps: { status: pendingStatus } },
    );
    act(() => {
      expect(
        result.current.accept(
          { expectedIdentityRevision: targetIdentityRevision, requestId: 'request-1' },
          {
            accepted: true,
            acceptedAt: new Date(),
            expectedIdentityRevision: targetIdentityRevision,
            requestId: 'request-1',
          },
        ),
      ).toBe(true);
    });
    expect(result.current.phase).toBe('accepted');

    rerender({
      status: {
        ...pendingStatus,
        active: { allFreshInstancesActive: true },
        pendingRestart: false,
      },
    });
    expect(result.current.phase).toBe('activated');
  });

  it('stops at the server-accepted deadline and retains request diagnostics', () => {
    vi.useFakeTimers();
    const acceptedAt = new Date('2026-07-19T00:00:00Z');
    vi.setSystemTime(acceptedAt);
    const { result } = renderHook(() =>
      useIdentityProviderRestartLifecycle({ error: null, status: pendingStatus }),
    );
    act(() => {
      result.current.accept(
        { expectedIdentityRevision: targetIdentityRevision, requestId: 'request-timeout' },
        {
          accepted: true,
          acceptedAt,
          expectedIdentityRevision: targetIdentityRevision,
          requestId: 'request-timeout',
        },
      );
    });
    act(() => vi.advanceTimersByTime(IDENTITY_PROVIDER_RESTART_TIMEOUT_MS));
    expect(result.current.phase).toBe('failed');
    expect(result.current.attempt).toMatchObject({
      requestId: 'request-timeout',
      targetIdentityRevision,
    });
  });
});
