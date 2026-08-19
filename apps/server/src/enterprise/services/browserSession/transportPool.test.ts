import { describe, expect, it, vi } from 'vitest';

import {
  buildBrowserSessionTransportPoolKey,
  createBrowserSessionTransportPool,
  registerBrowserSessionScopeDrain,
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
  it('drains a bound handle and is idempotent for an unknown key', async () => {
    const pool = createBrowserSessionTransportPool();
    const drain = vi.fn();
    pool.bind('k1', { drain });
    expect(pool.has('k1')).toBe(true);
    await pool.drain('k1');
    expect(drain).toHaveBeenCalledTimes(1);
    expect(pool.has('k1')).toBe(false);
    await pool.drain('k1');
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('drainAll drains every bound handle', async () => {
    const pool = createBrowserSessionTransportPool();
    const drainA = vi.fn();
    const drainB = vi.fn();
    pool.bind('a', { drain: drainA });
    pool.bind('b', { drain: drainB });
    await pool.drainAll?.();
    expect(drainA).toHaveBeenCalledTimes(1);
    expect(drainB).toHaveBeenCalledTimes(1);
    expect(pool.has('a')).toBe(false);
    expect(pool.has('b')).toBe(false);
  });

  it('settles a synchronous handle throw without skipping extra drains', async () => {
    let extraStarted = false;
    const unreg = registerBrowserSessionScopeDrain(() => {
      extraStarted = true;
      throw new Error('sync extra');
    });
    try {
      const pool = createBrowserSessionTransportPool();
      pool.bind('k1', {
        drain: () => {
          throw new Error('sync handle');
        },
      });
      await expect(pool.drain('k1')).rejects.toBeInstanceOf(AggregateError);
      expect(extraStarted).toBe(true);
    } finally {
      unreg();
    }
  });

  it('drainAll still starts later handles after a synchronous throw', async () => {
    let laterRan = false;
    const pool = createBrowserSessionTransportPool();
    pool.bind('a', {
      drain: () => {
        throw new Error('sync a');
      },
    });
    pool.bind('b', {
      drain: () => {
        laterRan = true;
      },
    });
    await expect(pool.drainAll?.()).rejects.toBeInstanceOf(AggregateError);
    expect(laterRan).toBe(true);
  });

  it('waits for every extra drain before rejecting when one fails', async () => {
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowFinished = false;
    const unregFail = registerBrowserSessionScopeDrain(async () => {
      throw new Error('persistent cleanup failed');
    });
    const unregSlow = registerBrowserSessionScopeDrain(async () => {
      await slow;
      slowFinished = true;
    });
    try {
      const pool = createBrowserSessionTransportPool();
      const pending = Promise.resolve(pool.drain('missing-key'));
      await Promise.resolve();
      expect(slowFinished).toBe(false);
      releaseSlow?.();
      await expect(pending).rejects.toThrow(/browser session drain failed/);
      expect(slowFinished).toBe(true);
    } finally {
      unregFail();
      unregSlow();
    }
  });
});
