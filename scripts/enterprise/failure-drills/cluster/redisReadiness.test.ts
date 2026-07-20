import { describe, expect, it, vi } from 'vitest';

import { waitForRedisHostReady } from './redisReadiness';

describe('waitForRedisHostReady', () => {
  it('retries bounded host probes and returns only after one succeeds', async () => {
    const probe = vi
      .fn<(connectionUrl: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('not forwarded'))
      .mockRejectedValueOnce(new Error('not forwarded'))
      .mockResolvedValue(undefined);

    await expect(
      waitForRedisHostReady({
        attemptTimeoutMs: 20,
        connectionUrl: 'redis://127.0.0.1:6379',
        intervalMs: 1,
        probe,
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('fails with a fixed error after the deadline instead of retrying forever', async () => {
    const probe = vi
      .fn<(connectionUrl: string) => Promise<void>>()
      .mockRejectedValue(new Error('not forwarded'));

    await expect(
      waitForRedisHostReady({
        attemptTimeoutMs: 5,
        connectionUrl: 'redis://127.0.0.1:6379',
        intervalMs: 1,
        probe,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ name: 'RedisHostReadinessTimeout' });
    expect(probe.mock.calls.length).toBeGreaterThan(0);
    expect(probe.mock.calls.length).toBeLessThan(30);
  });

  it('bounds a probe that never settles', async () => {
    const probe = vi.fn<(connectionUrl: string) => Promise<void>>(
      () => new Promise<void>(() => undefined),
    );

    await expect(
      waitForRedisHostReady({
        attemptTimeoutMs: 5,
        connectionUrl: 'redis://127.0.0.1:6379',
        intervalMs: 1,
        probe,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ name: 'RedisHostReadinessTimeout' });
  });
});
