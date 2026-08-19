import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBrowserSessionRegistry,
  resetBrowserSessionRegistryForTests,
} from './contextRegistry';
import { isBrowserCookieJarTombstoned, resetBrowserCookieJars } from './cookieJar';
import {
  createBrowserSessionOwnerLease,
  disposeBrowserSessionResources,
  isBrowserSessionLeaseHeldBy,
  onBrowserSessionBeforeDispose,
  onBrowserSessionInvalidate,
} from './lifecycle';
import type { BrowserSessionAcquireInput } from './types';

afterEach(async () => {
  await resetBrowserSessionRegistryForTests();
  resetBrowserCookieJars();
});

const baseInput = (
  overrides: Partial<BrowserSessionAcquireInput> = {},
): BrowserSessionAcquireInput => ({
  accountId: 'conn-account-1',
  browserProfileRevision: 1,
  origin: 'https://chatgpt.com',
  provider: 'chatgptweb',
  ...overrides,
});

describe('disposeBrowserSessionResources', () => {
  it('disposeBrowserSessionResources drains transport before deleting the jar', async () => {
    const order: string[] = [];
    let releaseDrain: (() => void) | undefined;
    const drainPromise = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const pathHolder: { path?: string } = {};
    const pool = {
      bind: vi.fn(),
      drain: (key: string) => {
        order.push(`drain:${key}`);
        expect(existsSync(pathHolder.path!)).toBe(true);
        expect(isBrowserCookieJarTombstoned(pathHolder.path!)).toBe(true);
        return drainPromise;
      },
      has: () => false,
    };
    const registry = createBrowserSessionRegistry({ transportPool: pool });
    const context = registry.acquire(baseInput());
    pathHolder.path = context.cookieJar.path;
    expect(existsSync(context.cookieJar.path)).toBe(true);

    const unsubscribe = onBrowserSessionInvalidate(() => {
      order.push(existsSync(context.cookieJar.path) ? 'listener-jar-present' : 'listener-jar-gone');
    });

    const pending = disposeBrowserSessionResources(context, { transportPool: pool });
    expect(existsSync(context.cookieJar.path)).toBe(true);
    expect(order).toEqual([`drain:${context.transportPoolKey}`]);

    releaseDrain?.();
    await pending;
    unsubscribe();

    expect(order[0]?.startsWith('drain:')).toBe(true);
    expect(order).toContain('listener-jar-gone');
    expect(existsSync(context.cookieJar.path)).toBe(false);
    expect(isBrowserCookieJarTombstoned(context.cookieJar.path)).toBe(true);
  });

  it('onBrowserSessionInvalidate runs after drain and jar delete', async () => {
    const order: string[] = [];
    let releaseDrain: (() => void) | undefined;
    const drainPromise = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const unsubscribe = onBrowserSessionInvalidate(() => {
      order.push('listener');
    });
    const registry = createBrowserSessionRegistry({
      transportPool: {
        bind: vi.fn(),
        drain: () => {
          order.push('drain');
          return drainPromise;
        },
        has: () => false,
      },
    });
    const context = registry.acquire(baseInput());
    const path = context.cookieJar.path;
    registry.invalidate(context.contextId);
    expect(order).toEqual(['drain']);
    expect(existsSync(path)).toBe(true);

    releaseDrain?.();
    await registry.awaitPendingCleanup();
    unsubscribe();
    expect(order).toEqual(['drain', 'listener']);
    expect(existsSync(path)).toBe(false);
  });

  it('isBrowserSessionLeaseHeldBy matches pid owner', () => {
    const lease = createBrowserSessionOwnerLease({ ownerId: `pid:${process.pid}` });
    expect(isBrowserSessionLeaseHeldBy(lease, `pid:${process.pid}`)).toBe(true);
    expect(isBrowserSessionLeaseHeldBy(lease, 'pid:0')).toBe(false);
  });

  it('onBrowserSessionBeforeDispose runs before drain', async () => {
    const order: string[] = [];
    let releaseDrain: (() => void) | undefined;
    const drainPromise = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const unsubBefore = onBrowserSessionBeforeDispose(() => {
      order.push('before');
    });
    const unsubAfter = onBrowserSessionInvalidate(() => {
      order.push('after');
    });
    const registry = createBrowserSessionRegistry({
      transportPool: {
        bind: vi.fn(),
        drain: () => {
          order.push('drain');
          return drainPromise;
        },
        has: () => false,
      },
    });
    const context = registry.acquire(baseInput());
    registry.invalidate(context.contextId);
    expect(order).toEqual(['before', 'drain']);
    releaseDrain?.();
    await registry.awaitPendingCleanup();
    unsubBefore();
    unsubAfter();
    expect(order).toEqual(['before', 'drain', 'after']);
  });

  it('does not unlink the jar when one drain rejects while another is still pending', async () => {
    let releaseChild: (() => void) | undefined;
    const childPending = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let rejectedSettled = false;
    const registry = createBrowserSessionRegistry({
      transportPool: {
        bind: vi.fn(),
        drain: () => {
          rejectedSettled = true;
          return childPending.then(() => {
            throw new AggregateError(
              [new Error('curl_multi_cleanup failed')],
              'browser session drain failed',
            );
          });
        },
        has: () => false,
      },
    });
    const context = registry.acquire(baseInput());
    const path = context.cookieJar.path;
    expect(existsSync(path)).toBe(true);
    registry.invalidate(context.contextId);
    await vi.waitFor(() => expect(rejectedSettled).toBe(true));
    expect(existsSync(path)).toBe(true);
    releaseChild?.();
    await expect(registry.awaitPendingCleanup()).rejects.toBeInstanceOf(AggregateError);
    expect(existsSync(path)).toBe(true);
    expect(isBrowserCookieJarTombstoned(path)).toBe(true);
  });
});
