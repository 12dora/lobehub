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
  publishError: null,
  published: false,
  revision: null,
  status: 'pending' as const,
  stored: false,
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

const renderFlow = (onSuccess?: (outcome: unknown) => void) =>
  renderHook(() => useAdminSharedOAuthFlow({ onSuccess, providerId: 'chatgpt' }));

describe('useAdminSharedOAuthFlow', () => {
  it('polls once per interval, backs off on slow_down and reports the store outcome', async () => {
    mocks.poll
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...pending, status: 'slow_down' })
      .mockResolvedValueOnce({
        publishError: 'validation_failed',
        published: false,
        revision: 1,
        status: 'success',
        stored: true,
      });

    const onSuccess = vi.fn();
    const { result } = renderFlow(onSuccess);

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
    expect(result.current.outcome).toEqual({ publishError: 'validation_failed', published: false });
    expect(onSuccess).toHaveBeenCalledWith({ publishError: 'validation_failed', published: false });

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
    mocks.poll.mockRejectedValueOnce(reauthError).mockResolvedValueOnce({
      publishError: null,
      published: true,
      revision: 2,
      status: 'success',
      stored: true,
    });

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
    expect(result.current.outcome).toEqual({ publishError: null, published: true });
  });

  it.each([
    ['denied', 'denied'],
    ['expired', 'codeExpired'],
  ])('surfaces %s as a retryable error state', async (status, expected) => {
    mocks.poll.mockResolvedValueOnce({ ...pending, status });

    const { result } = renderFlow();
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe(expected);

    // Terminal: the loop is stopped, not silently retrying.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);
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

    const { result } = renderFlow();
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('codeExpired');
    const pollsAtExpiry = mocks.poll.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(pollsAtExpiry);
  });

  it('reset cancels an in-flight flow', async () => {
    mocks.poll.mockResolvedValue(pending);

    const { result } = renderFlow();
    await act(async () => {
      await result.current.connect();
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.deviceCode).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.poll).not.toHaveBeenCalled();
  });
});
