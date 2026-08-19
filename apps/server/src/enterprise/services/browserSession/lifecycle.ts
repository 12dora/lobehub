import debug from 'debug';

import { deleteBrowserCookieJar, tombstoneBrowserCookieJar } from './cookieJar';
import type { BrowserSessionTransportPool } from './transportPool';
import type { BrowserSessionContext, BrowserSessionOwnerLease } from './types';

const log = debug('lobe-server:browser-session');

export const createBrowserSessionOwnerLease = (params?: {
  now?: number;
  ownerId?: string;
}): BrowserSessionOwnerLease => ({
  acquiredAt: params?.now ?? Date.now(),
  ownerId: params?.ownerId ?? `pid:${process.pid}`,
});

export const isBrowserSessionActive = (context: BrowserSessionContext): boolean =>
  context.lifecycle === 'active';

export const isBrowserSessionLeaseHeldBy = (
  lease: BrowserSessionOwnerLease,
  ownerId: string,
): boolean => lease.ownerId === ownerId;

export const markBrowserSessionInvalidated = (context: BrowserSessionContext): void => {
  context.lifecycle = 'invalidated';
};

export const markBrowserSessionReleased = (context: BrowserSessionContext): void => {
  context.lifecycle = 'released';
};

/**
 * Provider-neutral invalidate hook. ChatGPT (and any future adapter) subscribes
 * here so the common layer never imports provider code.
 */
export type BrowserSessionInvalidateListener = (context: BrowserSessionContext) => void;

const invalidateListeners = new Set<BrowserSessionInvalidateListener>();

export const onBrowserSessionInvalidate = (fn: BrowserSessionInvalidateListener): (() => void) => {
  invalidateListeners.add(fn);
  return () => {
    invalidateListeners.delete(fn);
  };
};

export const notifyBrowserSessionInvalidated = (context: BrowserSessionContext): void => {
  for (const listener of invalidateListeners) {
    try {
      listener(context);
    } catch (error) {
      log(
        'onInvalidate listener failed context=%s: %s',
        context.contextId,
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  }
};

const awaitDrain = async (drained: void | Promise<void>, contextId: string): Promise<void> => {
  try {
    await Promise.resolve(drained);
  } catch (error) {
    log(
      'transport drain failed context=%s: %s',
      contextId,
      error instanceof Error ? error.message : 'UnknownError',
    );
  }
};

/**
 * Ordered dispose (C4):
 * 1. Caller fences first (`lifecycle` + `revision++`) so writes no-op.
 * 2. Tombstone the jar immediately so JS writers cannot recreate it.
 * 3. Await this context's transport drains (persistent pool + CLI children).
 * 4. Unlink the jar. Tombstones stay in a bounded LRU until process reset;
 *    retired context keys (ChatGPT) fence stale traffic.
 * 5. Provider `onInvalidate` listeners (jar-path unregister, Sentinel slot, …).
 *
 * `drainAll` is shutdown/test-reset only — see registry `dispose`.
 */
export const disposeBrowserSessionResources = async (
  context: BrowserSessionContext,
  deps: { transportPool: BrowserSessionTransportPool },
): Promise<void> => {
  tombstoneBrowserCookieJar(context.cookieJar.path);
  const drained = deps.transportPool.drain(context.transportPoolKey);
  if (drained && typeof (drained as Promise<void>).then === 'function') {
    await awaitDrain(drained, context.contextId);
  }
  deleteBrowserCookieJar(context.cookieJar.path);
  notifyBrowserSessionInvalidated(context);
};
