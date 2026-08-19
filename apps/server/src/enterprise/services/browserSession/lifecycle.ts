import { deleteBrowserCookieJar } from './cookieJar';
import type { BrowserSessionTransportPool } from './transportPool';
import type { BrowserSessionContext, BrowserSessionOwnerLease } from './types';

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
 * Drop the jar and drain the transport-pool key. C4 will add idle expiry,
 * bounded counts, and write fencing; this is the process-local cleanup hook.
 */
export const disposeBrowserSessionResources = (
  context: BrowserSessionContext,
  deps: { transportPool: BrowserSessionTransportPool },
): void => {
  deps.transportPool.drain(context.transportPoolKey);
  deleteBrowserCookieJar(context.cookieJar.path);
};
