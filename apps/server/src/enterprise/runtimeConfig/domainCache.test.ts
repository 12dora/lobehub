// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnterpriseObservabilityEvent } from '../observability';
import {
  NOOP_ENTERPRISE_STRUCTURED_LOGGER,
  setEnterprisePlatformObserverForTest,
  setEnterpriseStructuredLoggerForTest,
} from '../observability';
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
  onEntryStored?: (value: MutableValue | null) => void;
  onLoadFailure?: (error: unknown) => void;
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
    observabilityDomain: 'branding',
    onEntryStored: options.onEntryStored,
    onLoadFailure: options.onLoadFailure,
  });

beforeEach(() => {
  resetDomainConfigCachesForTest();
});

afterEach(() => {
  setEnterprisePlatformObserverForTest(null);
  setEnterpriseStructuredLoggerForTest(null);
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

    await expect(Promise.all([first, second])).resolves.toEqual([{ revision: 7 }, { revision: 7 }]);
    expect(load).toHaveBeenCalledOnce();
  });

  it('isolates domain namespaces that share a reader and cache id', async () => {
    const cacheKey = {};
    const first = createCache({
      cacheKey,
      epoch: async () => '1',
      load: async () => ({ revision: 1 }),
    });
    const second = new DomainConfigCache<MutableValue>({
      cacheId: 'published',
      cacheKey,
      cloneValue: (value) => ({ ...value }),
      getScopeEpoch: async () => '1',
      load: async () => ({ revision: 2 }),
      namespace: 'other-domain',
      observabilityDomain: 'skill_catalog',
    });

    await expect(first.get()).resolves.toEqual({ revision: 1 });
    await expect(second.get()).resolves.toEqual({ revision: 2 });
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
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('TTL fallback'), {
      errorClass: 'Error',
    });
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

  it('observes only real cache stores, never hits or coalesced callers', async () => {
    let epoch = '1';
    const pending = deferred<MutableValue | null>();
    const load = vi
      .fn<() => Promise<MutableValue | null>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ revision: 2 });
    const onEntryStored = vi.fn();
    const cache = createCache({ epoch: async () => epoch, load, onEntryStored });

    const first = cache.get();
    const coalesced = cache.get();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    pending.resolve({ revision: 1 });
    await expect(Promise.all([first, coalesced])).resolves.toEqual([
      { revision: 1 },
      { revision: 1 },
    ]);
    await expect(cache.get()).resolves.toEqual({ revision: 1 });
    expect(onEntryStored).toHaveBeenCalledOnce();
    expect(onEntryStored).toHaveBeenLastCalledWith({ revision: 1 });

    epoch = '2';
    await expect(cache.get()).resolves.toEqual({ revision: 2 });
    expect(onEntryStored).toHaveBeenCalledTimes(2);
    expect(onEntryStored).toHaveBeenLastCalledWith({ revision: 2 });
  });

  it('observes each loader failure once and preserves the original error when observers throw', async () => {
    const original = new Error('database detail');
    const onLoadFailure = vi.fn(() => {
      throw new Error('observer detail');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = createCache({
      epoch: async () => '1',
      load: async () => {
        throw original;
      },
      onLoadFailure,
    });

    const first = cache.get();
    const coalesced = cache.get();
    const results = await Promise.allSettled([first, coalesced]);

    expect(results).toEqual([
      { reason: original, status: 'rejected' },
      { reason: original, status: 'rejected' },
    ]);
    expect(onLoadFailure).toHaveBeenCalledOnce();
    expect(onLoadFailure).toHaveBeenCalledWith(original);
    expect(consoleError).toHaveBeenCalledWith(
      '[PlatformRuntimeConfig] cache failure observer unavailable',
      { errorClass: 'Error' },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('observer detail');
    consoleError.mockRestore();
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
    const onEntryStored = vi.fn();
    const cache = createCache({ cacheKey, epoch: async () => epoch, load, onEntryStored });

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
    expect(onEntryStored).toHaveBeenCalledOnce();
    expect(onEntryStored).toHaveBeenCalledWith({ revision: 2 });
  });

  it('does not report a late failure from an old epoch after the new flight is stored', async () => {
    let epoch = 'old';
    const oldLoad = deferred<MutableValue | null>();
    const newLoad = deferred<MutableValue | null>();
    const load = vi
      .fn<() => Promise<MutableValue | null>>()
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);
    const onEntryStored = vi.fn();
    const onLoadFailure = vi.fn();
    const cache = createCache({
      cacheKey: {},
      epoch: async () => epoch,
      load,
      onEntryStored,
      onLoadFailure,
    });

    const oldRequest = cache.get();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    epoch = 'new';
    const newRequest = cache.get();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    newLoad.resolve({ revision: 2 });
    await expect(newRequest).resolves.toEqual({ revision: 2 });

    const oldError = new Error('late old database failure');
    const oldResult = expect(oldRequest).rejects.toBe(oldError);
    oldLoad.reject(oldError);
    await oldResult;

    expect(onEntryStored).toHaveBeenCalledOnce();
    expect(onEntryStored).toHaveBeenCalledWith({ revision: 2 });
    expect(onLoadFailure).not.toHaveBeenCalled();
    await expect(cache.get()).resolves.toEqual({ revision: 2 });
    expect(load).toHaveBeenCalledTimes(2);
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

  it('classifies every cache request, load, and epoch outcome without cache identifiers', async () => {
    const events: EnterpriseObservabilityEvent[] = [];
    setEnterprisePlatformObserverForTest({ record: (event) => events.push(event) });
    setEnterpriseStructuredLoggerForTest(NOOP_ENTERPRISE_STRUCTURED_LOGGER);
    let epoch = '1';
    let now = 0;
    const firstLoad = deferred<MutableValue | null>();
    const load = vi
      .fn<() => Promise<MutableValue | null>>()
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('database detail'));
    const cache = createCache({ epoch: async () => epoch, load, now: () => now, ttl: 10 });

    const first = cache.get();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const coalesced = cache.get();
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        domain: 'branding',
        operation: 'request',
        outcome: 'coalesced',
        type: 'cache',
      }),
    );
    firstLoad.resolve({ revision: 1 });
    await expect(Promise.all([first, coalesced])).resolves.toEqual([
      { revision: 1 },
      { revision: 1 },
    ]);
    await expect(cache.get()).resolves.toEqual({ revision: 1 });
    epoch = '2';
    await expect(cache.get()).resolves.toBeNull();
    await expect(cache.get()).resolves.toBeNull();
    epoch = '3';
    now = 10;
    await expect(cache.get()).rejects.toThrow('database detail');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failedEpochCache = createCache({
      cacheKey: {},
      epoch: async () => {
        throw new Error('redis detail');
      },
      load: async () => ({ revision: 4 }),
    });
    await failedEpochCache.get();
    consoleError.mockRestore();

    const cacheEvents = events.filter(({ type }) => type === 'cache');
    expect(cacheEvents).toEqual(
      expect.arrayContaining([
        { domain: 'branding', operation: 'request', outcome: 'coalesced', type: 'cache' },
        { domain: 'branding', operation: 'request', outcome: 'hit', type: 'cache' },
        { domain: 'branding', operation: 'request', outcome: 'negative', type: 'cache' },
        { domain: 'branding', operation: 'load', outcome: 'loaded', type: 'cache' },
        { domain: 'branding', operation: 'load', outcome: 'loaded_negative', type: 'cache' },
        {
          domain: 'branding',
          errorClass: 'UnexpectedError',
          operation: 'load',
          outcome: 'load_failure',
          type: 'cache',
        },
        { domain: 'branding', operation: 'epoch', outcome: 'success', type: 'cache' },
        { domain: 'branding', operation: 'epoch', outcome: 'changed', type: 'cache' },
        { domain: 'branding', operation: 'epoch', outcome: 'failure', type: 'cache' },
      ]),
    );
    expect(JSON.stringify(cacheEvents)).not.toContain('test-domain');
    expect(JSON.stringify(cacheEvents)).not.toContain('database detail');
  });
});
