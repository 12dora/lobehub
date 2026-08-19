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

/** Fired synchronously after tombstone and before `transportPool.drain()`. */
export type BrowserSessionBeforeDisposeListener = (context: BrowserSessionContext) => void;

const invalidateListeners = new Set<BrowserSessionInvalidateListener>();
const beforeDisposeListeners = new Set<BrowserSessionBeforeDisposeListener>();

export const onBrowserSessionInvalidate = (fn: BrowserSessionInvalidateListener): (() => void) => {
  invalidateListeners.add(fn);
  return () => {
    invalidateListeners.delete(fn);
  };
};

export const onBrowserSessionBeforeDispose = (
  fn: BrowserSessionBeforeDisposeListener,
): (() => void) => {
  beforeDisposeListeners.add(fn);
  return () => {
    beforeDisposeListeners.delete(fn);
  };
};

const notifyListeners = (
  listeners: Set<(context: BrowserSessionContext) => void>,
  context: BrowserSessionContext,
  label: string,
): void => {
  for (const listener of listeners) {
    try {
      listener(context);
    } catch (error) {
      log(
        '%s listener failed context=%s: %s',
        label,
        context.contextId,
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  }
};

export const notifyBrowserSessionBeforeDispose = (context: BrowserSessionContext): void => {
  notifyListeners(beforeDisposeListeners, context, 'onBeforeDispose');
};

export const notifyBrowserSessionInvalidated = (context: BrowserSessionContext): void => {
  notifyListeners(invalidateListeners, context, 'onInvalidate');
};

/**
 * Ordered dispose (C4):
 * 1. Caller fences first (`lifecycle` + `revision++`) so writes no-op.
 * 2. Tombstone the jar immediately so JS writers cannot recreate it.
 * 3. Synchronous `onBeforeDispose` (ChatGPT retires the namespaced digest).
 * 4. Await this context's transport drains via `Promise.allSettled` (persistent
 *    pool + CLI children). Wait for every transport before deciding.
 * 5. Unlink the jar only when every drain settled fulfilled. On any rejection
 *    keep the tombstone, do not unlink, log an aggregate error.
 * 6. Tombstones stay in a bounded LRU until process reset.
 * 7. Provider `onInvalidate` listeners (Sentinel slot, …) still fire.
 *
 * `drainAll` is shutdown/test-reset only — see registry `dispose`.
 */
export const disposeBrowserSessionResources = async (
  context: BrowserSessionContext,
  deps: { transportPool: BrowserSessionTransportPool },
): Promise<void> => {
  tombstoneBrowserCookieJar(context.cookieJar.path);
  notifyBrowserSessionBeforeDispose(context);

  let drainError: unknown;
  try {
    const drained = deps.transportPool.drain(context.transportPoolKey);
    if (drained && typeof (drained as Promise<void>).then === 'function') {
      await drained;
    }
  } catch (error) {
    drainError = error;
    log(
      'transport drain failed context=%s: %s',
      context.contextId,
      error instanceof Error ? error.message : 'UnknownError',
    );
  }

  if (!drainError) {
    deleteBrowserCookieJar(context.cookieJar.path);
  }
  notifyBrowserSessionInvalidated(context);
  if (drainError) throw drainError;
};
