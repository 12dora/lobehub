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
    const acceptedAt = new Date();
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
            acceptedAt,
            convergenceDeadlineAt: new Date(
              acceptedAt.getTime() + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
            ),
            expectedIdentityRevision: targetIdentityRevision,
            remainingMs: IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
            requestId: 'request-1',
            serverNow: acceptedAt,
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

  it.each([-180_000, 180_000])(
    'stops on the relative server window with a browser clock offset of %i ms',
    (browserClockOffset) => {
      vi.useFakeTimers();
      const acceptedAt = new Date('2026-07-19T00:00:00Z');
      vi.setSystemTime(new Date(acceptedAt.getTime() + browserClockOffset));
      const { result } = renderHook(() =>
        useIdentityProviderRestartLifecycle({ error: null, status: pendingStatus }),
      );
      act(() => {
        result.current.accept(
          { expectedIdentityRevision: targetIdentityRevision, requestId: 'request-timeout' },
          {
            accepted: true,
            acceptedAt,
            convergenceDeadlineAt: new Date(
              acceptedAt.getTime() + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
            ),
            expectedIdentityRevision: targetIdentityRevision,
            remainingMs: IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
            requestId: 'request-timeout',
            serverNow: acceptedAt,
          },
        );
      });
      act(() => vi.advanceTimersByTime(IDENTITY_PROVIDER_RESTART_TIMEOUT_MS - 1));
      expect(result.current.phase).toBe('accepted');
      act(() => vi.advanceTimersByTime(1));
      expect(result.current.phase).toBe('failed');
      expect(result.current.attempt).toMatchObject({
        requestId: 'request-timeout',
        targetIdentityRevision,
      });
    },
  );
});
