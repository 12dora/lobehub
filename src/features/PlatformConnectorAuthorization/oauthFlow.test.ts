import { describe, expect, it, vi } from 'vitest';

import { waitForManagedConnectorAuthorization } from './oauthFlow';
import type { ManagedConnectorBinding } from './types';

const binding = (status: ManagedConnectorBinding['status']): ManagedConnectorBinding => ({
  connectedAt: status === 'connected' ? new Date('2026-07-17T00:00:00Z') : null,
  expiresAt: null,
  id: 'binding-1',
  lastErrorCategory: status === 'error' ? 'oauth' : null,
  scopes: ['read'],
  status,
  updatedAt: new Date('2026-07-17T00:00:00Z'),
});

describe('waitForManagedConnectorAuthorization', () => {
  it('settles only after the server-owned binding is connected', async () => {
    let now = 0;
    const getStatus = vi
      .fn<() => Promise<ManagedConnectorBinding | null>>()
      .mockResolvedValueOnce(binding('pending'))
      .mockResolvedValueOnce(binding('connected'));

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

  it('reports a closed popup without claiming authorization success', async () => {
    await expect(
      waitForManagedConnectorAuthorization({
        getStatus: async () => binding('pending'),
        popup: { closed: true },
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ binding: { status: 'pending' }, status: 'dismissed' });
  });

  it('bounds a pending authorization with a timeout', async () => {
    let now = 0;
    await expect(
      waitForManagedConnectorAuthorization({
        getStatus: async () => binding('pending'),
        now: () => now,
        popup: { closed: false },
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 2000,
      }),
    ).resolves.toMatchObject({ binding: { status: 'pending' }, status: 'timeout' });
  });
});
