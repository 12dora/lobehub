import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminSharedOAuthFlow } from './useAdminSharedOAuthFlow';

const mocks = vi.hoisted(() => ({
  initiate: vi.fn(),
  poll: vi.fn(),
  reauthCount: { value: 0 },
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      aiProviderOAuth: {
        initiateDeviceCode: { mutate: (input: unknown) => mocks.initiate(input) },
        pollAuthStatus: { mutate: (input: unknown) => mocks.poll(input) },
      },
    },
  },
}));

// Mirrors withAdminReauthRetry: replay the SAME call once after re-authentication.
vi.mock('@/enterprise/client/services/adminAiInfraAdapter/shared', () => ({
  withReauth: async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ADMIN_REAUTH_REQUIRED') throw error;
      mocks.reauthCount.value += 1;
      return fn();
    }
  },
}));

const deviceCodeResponse = {
  deviceCode: 'device-code-1',
  expiresIn: 600,
  interval: 5,
  userCode: 'ABCD-1234',
  verificationUri: 'https://example.com/device',
  verificationUriComplete: 'https://example.com/device?user_code=ABCD-1234',
};

const pending = {
  revision: null,
  status: 'pending' as const,
  stored: false,
};

const success = {
  revision: 2,
  status: 'success' as const,
  stored: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.initiate.mockReset().mockResolvedValue(deviceCodeResponse);
  mocks.poll.mockReset();
  mocks.reauthCount.value = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

interface FlowOptions {
  onStatusStale?: () => void;
  onSuccess?: (outcome: unknown) => void;
}

const renderFlow = (options: FlowOptions = {}) =>
  renderHook(() => useAdminSharedOAuthFlow({ ...options, providerId: 'chatgpt' }));

/** A promise the test resolves by hand, to hold a call "in flight". */
const deferred = <T>() => {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
};

describe('useAdminSharedOAuthFlow', () => {
  it('polls once per interval, backs off on slow_down and reports the applied revision', async () => {
    mocks.poll
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...pending, status: 'slow_down' })
      .mockResolvedValueOnce({ revision: 1, status: 'success', stored: true });

    const onSuccess = vi.fn();
    const { result } = renderFlow({ onSuccess });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.state).toBe('awaiting');
    expect(result.current.deviceCode?.userCode).toBe('ABCD-1234');
    expect(mocks.poll).not.toHaveBeenCalled();

    // interval = 5s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(2);

    // slow_down pushes the next tick to 10s — nothing at 5s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(3);
    expect(result.current.state).toBe('success');
    expect(result.current.outcome).toEqual({ revision: 1 });
    expect(onSuccess).toHaveBeenCalledWith({ revision: 1 });

    // Flow stopped: no further polling after success.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(3);
  });

  it('replays the reauth-gated success tick with the same device code', async () => {
    const reauthError = Object.assign(new Error('ADMIN_REAUTH_REQUIRED'), {
      code: 'ADMIN_REAUTH_REQUIRED',
    });
    mocks.poll.mockRejectedValueOnce(reauthError).mockResolvedValueOnce(success);

    const { result } = renderFlow();
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mocks.reauthCount.value).toBe(1);
    expect(mocks.poll).toHaveBeenCalledTimes(2);
    expect(mocks.poll.mock.calls.every(([input]) => input.deviceCode === 'device-code-1')).toBe(
      true,
    );
    expect(result.current.state).toBe('success');
    expect(result.current.outcome).toEqual({ revision: 2 });
  });

  it('surfaces a reauth failure that survives the replay as a retryable error', async () => {
    const reauthError = Object.assign(new Error('ADMIN_REAUTH_REQUIRED'), {
      code: 'ADMIN_REAUTH_REQUIRED',
    });
    // Both the original call and the post-reauth replay reject: reauth was refused.
    mocks.poll.mockRejectedValue(reauthError);

    const onStatusStale = vi.fn();
    const { result } = renderFlow({ onStatusStale });
    await act(async () => {
      await result.current.connect();
    });

    // One failed poll must not kill a still-valid user code (M7 bound = 3).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.state).toBe('awaiting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('authError');
    expect(mocks.reauthCount.value).toBe(3);
    expect(onStatusStale).toHaveBeenCalled();
  });

  it.each([
    ['denied', 'denied'],
    ['expired', 'codeExpired'],
  ])('surfaces %s as a retryable error state', async (status, expected) => {
    mocks.poll.mockResolvedValueOnce({ ...pending, status });

    const onStatusStale = vi.fn();
    const { result } = renderFlow({ onStatusStale });
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe(expected);
    // Terminal transition re-reads the stored connection state (M6).
    expect(onStatusStale).toHaveBeenCalledTimes(1);

    // Terminal: the loop is stopped, not silently retrying.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a failed credential store from a provider-side denial', async () => {
    // Exact terminal shape the server sends when the grant was redeemed but the store failed.
    mocks.poll.mockResolvedValueOnce({
      error: 'provider_store_failed',
      revision: null,
      status: 'denied',
      stored: false,
    });

    const onStatusStale = vi.fn();
    const { result } = renderFlow({ onStatusStale });
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.state).toBe('error');
    // The admin DID consent — "denied by the provider" would send them to the wrong fix.
    expect(result.current.error).toBe('providerStoreFailed');
    expect(onStatusStale).toHaveBeenCalledTimes(1);

    // Still terminal: the single-use grant is spent, so the loop must stop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);
  });

  it('keeps a plain denial as a denial when no error code is attached', async () => {
    mocks.poll.mockResolvedValueOnce({
      error: null,
      revision: null,
      status: 'denied',
      stored: false,
    });

    const { result } = renderFlow();
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.error).toBe('denied');
  });

  it('keeps polling through transient failures and gives up after three in a row', async () => {
    mocks.poll
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      // A server answer clears the failure budget…
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'));

    const { result } = renderFlow();
    await act(async () => {
      await result.current.connect();
    });

    // Two blips then a pending answer: the user code is still valid, keep waiting.
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(result.current.state).toBe('awaiting');
    }
    expect(mocks.poll).toHaveBeenCalledTimes(3);

    // …so the next two failures are only #1 and #2 of a fresh streak.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(5);
    expect(result.current.state).toBe('awaiting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(6);
    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('authError');

    // Bounded failure = terminal: no zombie loop behind the error view.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(6);
  });

  it('fails closed when the device code request fails', async () => {
    mocks.initiate.mockRejectedValueOnce(new Error('nope'));

    const { result } = renderFlow();
    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('authError');
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it('expires the flow when the device code lifetime elapses', async () => {
    mocks.poll.mockResolvedValue(pending);

    const onStatusStale = vi.fn();
    const { result } = renderFlow({ onStatusStale });
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('codeExpired');
    expect(onStatusStale).toHaveBeenCalledTimes(1);
    const pollsAtExpiry = mocks.poll.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(pollsAtExpiry);
  });

  it('reset cancels an in-flight flow and re-reads the connection status', async () => {
    mocks.poll.mockResolvedValue(pending);

    const onStatusStale = vi.fn();
    const { result } = renderFlow({ onStatusStale });
    await act(async () => {
      await result.current.connect();
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.deviceCode).toBeUndefined();
    // The server may already hold a connection this cancel cannot undo (M6).
    expect(onStatusStale).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it('re-reads the status when a poll stores the connection after a cancel', async () => {
    const inFlight = deferred<typeof success>();
    mocks.poll.mockImplementationOnce(() => inFlight.promise);

    const onStatusStale = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderFlow({ onStatusStale, onSuccess });
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reset();
    });
    expect(onStatusStale).toHaveBeenCalledTimes(1);

    // The store already committed server-side: the outcome must not vanish silently.
    await act(async () => {
      inFlight.settle(success);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onStatusStale).toHaveBeenCalledTimes(2);
    // The cancelled run still does not hijack the view back into its success state.
    expect(result.current.state).toBe('idle');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('stops for good when the hook unmounts while the device code request is in flight', async () => {
    const inFlight = deferred<typeof deviceCodeResponse>();
    mocks.initiate.mockImplementationOnce(() => inFlight.promise);
    mocks.poll.mockResolvedValue(pending);

    const onStatusStale = vi.fn();
    const { result, unmount } = renderFlow({ onStatusStale });
    let connecting!: Promise<unknown>;
    act(() => {
      connecting = result.current.connect();
    });

    unmount();

    await act(async () => {
      inFlight.settle(deviceCodeResponse);
      await connecting;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // The resumed connect() must not re-arm the loop it had not started yet: no poll,
    // and no lingering poll/expiry timer either (an armed timer is a leak even if inert).
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(onStatusStale).not.toHaveBeenCalled();
  });

  it('stops for good when the hook unmounts while a poll is in flight', async () => {
    const inFlight = deferred<typeof pending>();
    mocks.poll.mockImplementationOnce(() => inFlight.promise).mockResolvedValue(pending);

    const { result, unmount } = renderFlow();
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      inFlight.settle(pending);
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
