import { describe, expect, it, vi } from 'vitest';

import { waitForManagedConnectorAuthorization } from './oauthFlow';
import type { ManagedConnectorBinding, UserConnectorAuthorizationStatusOutput } from './types';

const ATTEMPT_ID = '0123456789abcdef0123456789abcdef';

const binding = (status: ManagedConnectorBinding['status']): ManagedConnectorBinding => ({
  connectedAt: status === 'connected' ? new Date('2026-07-17T00:00:00Z') : null,
  expiresAt: null,
  id: 'binding-1',
  lastErrorCategory: status === 'error' ? 'oauth' : null,
  scopes: ['read'],
  status,
  updatedAt: new Date('2026-07-17T00:00:00Z'),
});

const attempt = (
  status: UserConnectorAuthorizationStatusOutput['status'],
  currentBinding: ManagedConnectorBinding | null = null,
): UserConnectorAuthorizationStatusOutput => ({
  attemptId: ATTEMPT_ID,
  binding: currentBinding,
  status,
});

describe('waitForManagedConnectorAuthorization', () => {
  it('settles only after this server-owned attempt completes', async () => {
    let now = 0;
    const getStatus = vi
      .fn<() => Promise<UserConnectorAuthorizationStatusOutput>>()
      .mockResolvedValueOnce(attempt('pending'))
      .mockResolvedValueOnce(attempt('completed', binding('connected')));

    await expect(
      waitForManagedConnectorAuthorization({
        getStatus,
        now: () => now,
        popup: { closed: false },
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).resolves.toMatchObject({ binding: { status: 'connected' }, status: 'connected' });
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'expired', 'superseded', 'invalid'] as const)(
    'stops on the explicit %s attempt outcome',
    async (status) => {
      await expect(
        waitForManagedConnectorAuthorization({
          getStatus: async () => attempt(status),
          popup: { closed: false },
        }),
      ).resolves.toEqual({ binding: null, status });
    },
  );

  it('never treats an old connected binding as success for a failed attempt', async () => {
    await expect(
      waitForManagedConnectorAuthorization({
        getStatus: async () => attempt('failed', binding('connected')),
        popup: { closed: false },
      }),
    ).resolves.toEqual({ binding: null, status: 'failed' });
  });

  it('reports a closed popup without claiming authorization success', async () => {
    await expect(
      waitForManagedConnectorAuthorization({
        getStatus: async () => attempt('pending'),
        popup: { closed: true },
        sleep: async () => {},
      }),
    ).resolves.toEqual({ binding: null, status: 'dismissed' });
  });

  it('bounds a pending authorization with a timeout', async () => {
    let now = 0;
    await expect(
      waitForManagedConnectorAuthorization({
        getStatus: async () => attempt('pending'),
        now: () => now,
        popup: { closed: false },
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 2000,
      }),
    ).resolves.toEqual({ binding: null, status: 'timeout' });
  });

  it('does not start polling when already cancelled', async () => {
    const controller = new AbortController();
    const getStatus = vi.fn<() => Promise<UserConnectorAuthorizationStatusOutput>>();
    controller.abort();

    await expect(
      waitForManagedConnectorAuthorization({
        getStatus,
        popup: { closed: false },
        signal: controller.signal,
      }),
    ).resolves.toEqual({ binding: null, status: 'cancelled' });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('cancels an in-flight poll and never schedules another request', async () => {
    const controller = new AbortController();
    const getStatus = vi.fn(
      () => new Promise<UserConnectorAuthorizationStatusOutput>(() => undefined),
    );
    const result = waitForManagedConnectorAuthorization({
      getStatus,
      popup: { closed: false },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledOnce());

    controller.abort();

    await expect(result).resolves.toEqual({ binding: null, status: 'cancelled' });
    expect(getStatus).toHaveBeenCalledOnce();
  });
});
