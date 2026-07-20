// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DomainConfigCache, resetDomainConfigCachesForTest } from './domainCache';

const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
};

interface MutableValue {
  revision: number;
}

const createCache = (options: {
  cacheKey?: object;
  epoch: () => Promise<string>;
  load: () => Promise<MutableValue | null>;
  now?: () => number;
  ttl?: number;
}) =>
  new DomainConfigCache<MutableValue>({
    cacheId: 'published',
    cacheKey: options.cacheKey ?? {},
    cacheTtlMs: options.ttl ?? 100,
    cloneValue: (value) => ({ ...value }),
    getScopeEpoch: options.epoch,
    load: options.load,
    namespace: 'test-domain',
    now: options.now,
  });

beforeEach(() => {
  resetDomainConfigCachesForTest();
});

describe('DomainConfigCache', () => {
  it('uses one loader flight for the same reader and epoch across independent cache instances', async () => {
    const cacheKey = {};
    const pending = deferred<MutableValue | null>();
    const load = vi.fn(() => pending.promise);
    const options = { cacheKey, epoch: async () => '7', load };
    const firstCache = createCache(options);
    const secondCache = createCache(options);

    const first = firstCache.get();
    const second = secondCache.get();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    pending.resolve({ revision: 7 });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { revision: 7 },
      { revision: 7 },
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it('refreshes for every opaque epoch change, including nonzero to zero', async () => {
    let epoch = '9';
    const load = vi
      .fn<() => Promise<MutableValue | null>>()
      .mockResolvedValueOnce({ revision: 9 })
      .mockResolvedValueOnce({ revision: 10 });
    const cache = createCache({ epoch: async () => epoch, load });

    await expect(cache.get()).resolves.toEqual({ revision: 9 });
    epoch = '0';
    await expect(cache.get()).resolves.toEqual({ revision: 10 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('converges from the database after an event is lost and the exact TTL boundary arrives', async () => {
    let databaseRevision = 1;
    let now = 1_000;
    const load = vi.fn(async () => ({ revision: databaseRevision }));
    const cache = createCache({
      epoch: async () => 'unchanged-event-version',
      load,
      now: () => now,
      ttl: 100,
    });

    await expect(cache.get()).resolves.toEqual({ revision: 1 });
    databaseRevision = 2;
    now = 1_099;
    await expect(cache.get()).resolves.toEqual({ revision: 1 });
    now = 1_100;
    await expect(cache.get()).resolves.toEqual({ revision: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('uses bounded TTL convergence while the epoch reader is unavailable', async () => {
    let databaseRevision = 1;
    let now = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi.fn(async () => ({ revision: databaseRevision }));
    const cache = createCache({
      epoch: async () => {
        throw new Error('redis unavailable');
      },
      load,
      now: () => now,
      ttl: 50,
    });

    await expect(cache.get()).resolves.toEqual({ revision: 1 });
    databaseRevision = 2;
    now = 50;
    await expect(cache.get()).resolves.toEqual({ revision: 2 });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('TTL fallback'),
      { errorClass: 'Error' },
    );
    consoleError.mockRestore();
  });

  it('negative-caches absence but never caches loader failures', async () => {
    const load = vi
      .fn<() => Promise<MutableValue | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ revision: 2 });
    let now = 0;
    const cache = createCache({ epoch: async () => '1', load, now: () => now, ttl: 10 });

    await expect(cache.get()).resolves.toBeNull();
    await expect(cache.get()).resolves.toBeNull();
    now = 10;
    await expect(cache.get()).rejects.toThrow('database unavailable');
    await expect(cache.get()).resolves.toEqual({ revision: 2 });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('prevents an old epoch generation from contaminating newer cache state', async () => {
    let epoch = 'old';
    const oldLoad = deferred<MutableValue | null>();
    const newLoad = deferred<MutableValue | null>();
    const load = vi
      .fn<() => Promise<MutableValue | null>>()
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);
    const cacheKey = {};
    const cache = createCache({ cacheKey, epoch: async () => epoch, load });

    const oldRequest = cache.get();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    epoch = 'new';
    const newRequest = cache.get();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    newLoad.resolve({ revision: 2 });
    await expect(newRequest).resolves.toEqual({ revision: 2 });
    oldLoad.resolve({ revision: 1 });
    await expect(oldRequest).resolves.toEqual({ revision: 1 });
    await expect(cache.get()).resolves.toEqual({ revision: 2 });
  });

  it('does not let an in-flight request from before reset delete or populate new work', async () => {
    const oldLoad = deferred<MutableValue | null>();
    const newLoad = deferred<MutableValue | null>();
    const load = vi
      .fn<() => Promise<MutableValue | null>>()
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);
    const cache = createCache({ cacheKey: {}, epoch: async () => '1', load });

    const beforeReset = cache.get();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    resetDomainConfigCachesForTest();
    const afterReset = cache.get();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    oldLoad.resolve({ revision: 1 });
    await expect(beforeReset).resolves.toEqual({ revision: 1 });
    const sharedAfterReset = cache.get();
    expect(load).toHaveBeenCalledTimes(2);
    newLoad.resolve({ revision: 2 });
    await expect(Promise.all([afterReset, sharedAfterReset])).resolves.toEqual([
      { revision: 2 },
      { revision: 2 },
    ]);
    await expect(cache.get()).resolves.toEqual({ revision: 2 });
  });
});
