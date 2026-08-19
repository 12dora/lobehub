import { describe, expect, it, vi } from 'vitest';

import {
  buildBrowserSessionTransportPoolKey,
  createBrowserSessionTransportPool,
} from './transportPool';

describe('buildBrowserSessionTransportPoolKey', () => {
  it('is stable for the same inputs and changes with context, origin, proxy, or profile', () => {
    const base = {
      contextId: 'ctx-1',
      impersonationProfileRevision: 'chrome136',
      origin: 'https://chatgpt.com',
      proxyOutlet: 'proxy-a',
    };
    const key = buildBrowserSessionTransportPoolKey(base);
    expect(buildBrowserSessionTransportPoolKey(base)).toBe(key);
    expect(buildBrowserSessionTransportPoolKey({ ...base, contextId: 'ctx-2' })).not.toBe(key);
    expect(buildBrowserSessionTransportPoolKey({ ...base, origin: 'https://openai.com' })).not.toBe(
      key,
    );
    expect(buildBrowserSessionTransportPoolKey({ ...base, proxyOutlet: 'proxy-b' })).not.toBe(key);
    expect(
      buildBrowserSessionTransportPoolKey({ ...base, impersonationProfileRevision: 'chrome150' }),
    ).not.toBe(key);
  });
});

describe('createBrowserSessionTransportPool', () => {
  it('drains a bound handle and is idempotent for an unknown key', () => {
    const pool = createBrowserSessionTransportPool();
    const drain = vi.fn();
    pool.bind('k1', { drain });
    expect(pool.has('k1')).toBe(true);
    pool.drain('k1');
    expect(drain).toHaveBeenCalledTimes(1);
    expect(pool.has('k1')).toBe(false);
    pool.drain('k1');
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('drainAll drains every bound handle', () => {
    const pool = createBrowserSessionTransportPool();
    const drainA = vi.fn();
    const drainB = vi.fn();
    pool.bind('a', { drain: drainA });
    pool.bind('b', { drain: drainB });
    pool.drainAll?.();
    expect(drainA).toHaveBeenCalledTimes(1);
    expect(drainB).toHaveBeenCalledTimes(1);
    expect(pool.has('a')).toBe(false);
    expect(pool.has('b')).toBe(false);
  });
});
