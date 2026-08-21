import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatGPTWebError } from './errors';
import type { MintedSentinelBundle, SentinelBundleBinding } from './sentinelBundlePool';
import {
  deriveSentinelContextKey,
  isSentinelBindingSuperseded,
  SentinelBundlePool,
} from './sentinelBundlePool';
import type { ChatRequirements } from './types';

const binding = (overrides: Partial<SentinelBundleBinding> = {}): SentinelBundleBinding => ({
  contextKey: 'ctx-1',
  deviceId: 'device-1',
  profileId: 'chrome-150',
  sessionId: 'session-1',
  ...overrides,
});

const requirements = (token: string): ChatRequirements => ({
  proofToken: `proof-${token}`,
  soToken: `so-${token}`,
  token,
  turnstileToken: `turnstile-${token}`,
});

const minted = (token: string, expiresAtMs = Date.now() + 60_000): MintedSentinelBundle => ({
  expiresAtMs,
  requirements: requirements(token),
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('deriveSentinelContextKey', () => {
  it('does not include credentials', () => {
    expect(
      deriveSentinelContextKey({
        deviceId: 'device-1',
        profileId: 'chrome-150',
        sessionId: 'session-1',
      }),
    ).toBe('chatgptweb:device-1:session-1:chrome-150');
  });
});

describe('isSentinelBindingSuperseded', () => {
  it('treats a device or profile change as superseded', () => {
    expect(isSentinelBindingSuperseded(binding(), binding({ deviceId: 'device-2' }))).toBe(true);
    expect(isSentinelBindingSuperseded(binding(), binding({ profileId: 'chrome-151' }))).toBe(true);
  });

  it('does not supersede when the incoming side has not bootstrapped build markers', () => {
    expect(
      isSentinelBindingSuperseded(
        binding({ clientVersion: 'prod-live' }),
        binding({ clientVersion: undefined }),
      ),
    ).toBe(false);
  });

  it('supersedes when both sides carry disagreeing live build markers', () => {
    expect(
      isSentinelBindingSuperseded(
        binding({ clientVersion: 'prod-a' }),
        binding({ clientVersion: 'prod-b' }),
      ),
    ).toBe(true);
  });
});

describe('SentinelBundlePool', () => {
  it('mints on a cold acquire and returns that bundle', async () => {
    const pool = new SentinelBundlePool();
    const mint = vi.fn(async () => minted('t1'));

    const acquired = await pool.acquire(binding(), mint);

    expect(mint).toHaveBeenCalledTimes(1);
    expect(acquired.requirements.token).toBe('t1');
    expect(acquired.id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
    );
  });

  it('acquires a warmed bundle without a same-turn handshake', async () => {
    const pool = new SentinelBundlePool();
    const mint = vi.fn(async () => minted('warm'));

    await pool.warm(binding(), mint);
    const acquired = await pool.acquire(binding(), mint);

    expect(mint).toHaveBeenCalledTimes(2);
    expect(acquired.requirements.token).toBe('warm');
  });

  it('warms up to two ready bundles so a turn does not empty the pool', async () => {
    const pool = new SentinelBundlePool();
    let n = 0;
    const mint = vi.fn(async () => minted(`t${(n += 1)}`));

    await pool.warm(binding(), mint);
    const first = await pool.acquire(binding(), mint);
    const second = await pool.acquire(binding(), mint);

    expect(mint).toHaveBeenCalledTimes(2);
    expect(first.requirements.token).toBe('t1');
    expect(second.requirements.token).toBe('t2');
  });

  it('does not consume the same bundle twice', async () => {
    const pool = new SentinelBundlePool();
    let n = 0;
    const mint = vi.fn(async () => minted(`t${(n += 1)}`));

    const first = await pool.acquire(binding(), mint);
    const second = await pool.acquire(binding(), mint);

    expect(mint).toHaveBeenCalledTimes(2);
    expect(first.id).not.toBe(second.id);
    expect(first.requirements.token).not.toBe(second.requirements.token);
  });

  it('replenishes a distinct next bundle that later acquires can take', async () => {
    const pool = new SentinelBundlePool();
    let n = 0;
    const mint = vi.fn(async () => minted(`t${(n += 1)}`));

    const first = await pool.acquire(binding(), mint);
    pool.replenish(binding(), mint);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(3));

    const second = await pool.acquire(binding(), mint);

    expect(mint).toHaveBeenCalledTimes(3);
    expect(first.requirements.token).toBe('t1');
    expect(second.requirements.token).toBe('t2');
    expect(first.id).not.toBe(second.id);
  });

  it('does not double-spend one bundle under concurrent acquire', async () => {
    const pool = new SentinelBundlePool();
    const mints = [deferred<MintedSentinelBundle>(), deferred<MintedSentinelBundle>()];
    const mint = vi.fn(() => {
      const next = mints[mint.mock.calls.length - 1];
      if (!next) throw new Error('unexpected extra mint');
      return next.promise;
    });

    const first = pool.acquire(binding(), mint);
    const second = pool.acquire(binding(), mint);

    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    mints[0].resolve(minted('shared'));
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
    mints[1].resolve(minted('other'));

    const [a, b] = await Promise.all([first, second]);
    const tokens = new Set([a.requirements.token, b.requirements.token]);
    expect(tokens).toEqual(new Set(['shared', 'other']));
    expect(a.id).not.toBe(b.id);
  });

  it('discards an expired bundle instead of replaying it', async () => {
    let now = 1000;
    const pool = new SentinelBundlePool({ now: () => now });
    const mint = vi
      .fn()
      .mockResolvedValueOnce(minted('stale', 1500))
      .mockResolvedValueOnce(minted('fresh', 5000));

    await pool.warm(binding(), mint);
    now = 2000;
    const acquired = await pool.acquire(binding(), mint);

    expect(mint.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(acquired.requirements.token).toBe('fresh');
  });

  it('discards superseded bundles when the device identity changes', async () => {
    const pool = new SentinelBundlePool();
    const mint = vi
      .fn()
      .mockResolvedValueOnce(minted('old-device'))
      .mockResolvedValueOnce(minted('old-device-2'))
      .mockResolvedValueOnce(minted('new-device'));

    await pool.warm(binding(), mint);
    const acquired = await pool.acquire(binding({ deviceId: 'device-2' }), mint);

    expect(mint.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(acquired.requirements.token).toBe('new-device');
    expect(acquired.binding.deviceId).toBe('device-2');
  });

  it('leaves the current turn intact when replenish fails, and retries on the next acquire', async () => {
    const pool = new SentinelBundlePool();
    const mint = vi
      .fn()
      .mockResolvedValueOnce(minted('turn'))
      .mockRejectedValueOnce(new ChatGPTWebError('network', 'finalize failed'))
      .mockResolvedValueOnce(minted('retry'));

    const first = await pool.acquire(binding(), mint);
    pool.replenish(binding(), mint);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));

    const second = await pool.acquire(binding(), mint);

    expect(first.requirements.token).toBe('turn');
    expect(second.requirements.token).toBe('retry');
    expect(mint).toHaveBeenCalledTimes(3);
  });

  it('does not park a failed mint as a ready bundle', async () => {
    const pool = new SentinelBundlePool();
    const mint = vi
      .fn()
      .mockRejectedValueOnce(new ChatGPTWebError('upstream', 'empty token'))
      .mockResolvedValueOnce(minted('ok'));

    await expect(pool.acquire(binding(), mint)).rejects.toMatchObject({ kind: 'upstream' });

    const acquired = await pool.acquire(binding(), mint);
    expect(acquired.requirements.token).toBe('ok');
  });

  it('propagates a caller abort instead of waiting forever on a sibling mint', async () => {
    const pool = new SentinelBundlePool();
    const blocked = deferred<MintedSentinelBundle>();
    const mint = vi.fn(() => blocked.promise);
    const controller = new AbortController();

    const first = pool.acquire(binding(), mint);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));

    const second = pool.acquire(binding(), mint, controller.signal);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    blocked.resolve(minted('kept'));
    await expect(first).resolves.toMatchObject({ requirements: { token: 'kept' } });
  });

  it('invalidate drops parked bundles for that context only', async () => {
    const pool = new SentinelBundlePool();
    const mint = vi.fn(async () => minted(`t${mint.mock.calls.length}`));

    await pool.warm(binding(), mint);
    await pool.warm(binding({ contextKey: 'ctx-2' }), mint);
    pool.invalidate('ctx-1');

    const a = await pool.acquire(binding(), mint);
    const b = await pool.acquire(binding({ contextKey: 'ctx-2' }), mint);

    expect(a.requirements.token).not.toBe(b.requirements.token);
    expect(mint.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('invalidate deletes the slot so a late mint cannot park', async () => {
    const pool = new SentinelBundlePool();
    const blocked = deferred<MintedSentinelBundle>();
    const mint = vi.fn(() => blocked.promise);

    const warm = pool.warm(binding(), mint);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    pool.invalidate('ctx-1');
    blocked.resolve(minted('late'));
    await warm;

    const after = vi.fn(async () => minted('fresh'));
    const acquired = await pool.acquire(binding(), after);
    expect(acquired.requirements.token).toBe('fresh');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('replenish started before invalidate does not park under the replacement contextKey', async () => {
    const pool = new SentinelBundlePool();
    const blocked = deferred<MintedSentinelBundle>();
    const mint = vi.fn(() => blocked.promise);

    pool.replenish(binding(), mint);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    pool.invalidate('ctx-1');
    blocked.resolve(minted('old-page'));

    await vi.waitFor(() => expect(blocked.promise).resolves.toMatchObject({}));
    const after = vi.fn(async () => minted('new-page'));
    const acquired = await pool.acquire(binding(), after);
    expect(acquired.requirements.token).toBe('new-page');
  });

  it('discardExpiring drops bundles that expire within the skew window', async () => {
    let now = 1000;
    const pool = new SentinelBundlePool({ now: () => now });
    const mint = vi
      .fn()
      .mockResolvedValueOnce(minted('soon', 20_000))
      .mockResolvedValueOnce(minted('later', 80_000))
      .mockResolvedValueOnce(minted('fresh', 90_000));

    await pool.warm(binding(), mint);
    await pool.discardExpiring('ctx-1', 30_000);
    await pool.warm(binding(), mint);

    now = 25_000;
    const acquired = await pool.acquire(binding(), mint);
    expect(acquired.requirements.token).toBe('later');
  });

  it('reset is safe when a mint is in flight', async () => {
    const pool = new SentinelBundlePool();
    const blocked = deferred<MintedSentinelBundle>();
    const mint = vi
      .fn()
      .mockImplementationOnce(() => blocked.promise)
      .mockImplementation(async () => minted('ok'));

    const pending = pool.acquire(binding(), mint);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    pool.reset();
    blocked.resolve(minted('after-reset'));
    await expect(pending).resolves.toMatchObject({ requirements: { token: 'ok' } });
  });
});
