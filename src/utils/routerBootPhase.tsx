'use client';

import { createContext, type ReactNode, use, useEffect, useSyncExternalStore } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';

/**
 * Boot phase for one router instance.
 *
 * "Boot" is the window between the SPA mounting and the *initially matched leaf
 * route* being on screen. Only inside that window may a route Suspense fallback
 * render the full-viewport brand splash — it is visually continuous with the
 * static splash in `index.html`. Every suspension after boot is an in-app
 * navigation and must render the inline fallback, otherwise leaving a page looks
 * like a full document reload.
 *
 * Two properties matter:
 *
 * 1. **It ends after the leaf commits, not after the first chunk resolves.** On a
 *    cold deep link the main layout chunk resolves first; the target route is
 *    still loading. Fallbacks are ref-counted, so while any route boundary is
 *    still pending the phase cannot settle.
 * 2. **It is per router instance.** A module-global latch would stay `false`
 *    across `createBrowserRouter` recreation (HMR, tests, desktop window reuse),
 *    silently disabling the boot splash for the next router.
 */
export interface RouterBootPhase {
  /** True until the initially matched leaf route has committed. */
  isBooting: () => boolean;
  /** Ref-count a pending route fallback. Returns the release function. */
  retainFallback: () => () => void;
  /** Ask to end boot; ignored while any fallback is still pending. */
  settleIfIdle: () => void;
  subscribe: (listener: () => void) => () => void;
}

export const createRouterBootPhase = (): RouterBootPhase => {
  let booting = true;
  let pending = 0;
  let scheduled = false;
  const listeners = new Set<() => void>();

  const scheduleSettle = () => {
    if (!booting || scheduled) return;
    scheduled = true;
    // Deferred to a microtask on purpose: React unmounts the outgoing fallback and
    // mounts the next one inside a single effect flush, so `pending` dips to 0 for
    // part of that synchronous block. Checking after the flush avoids ending boot
    // in that gap.
    queueMicrotask(() => {
      scheduled = false;
      if (!booting || pending > 0) return;
      booting = false;
      listeners.forEach((listener) => listener());
    });
  };

  return {
    isBooting: () => booting,
    retainFallback: () => {
      pending += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending -= 1;
        scheduleSettle();
      };
    },
    settleIfIdle: scheduleSettle,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/**
 * Default for trees rendered outside a router (Storybook, isolated component
 * tests): never booting, so nothing can accidentally paint a boot splash.
 */
const SETTLED_BOOT_PHASE: RouterBootPhase = {
  isBooting: () => false,
  retainFallback: () => () => {},
  settleIfIdle: () => {},
  subscribe: () => () => {},
};

export const RouterBootPhaseContext = createContext<RouterBootPhase>(SETTLED_BOOT_PHASE);

export const useRouterBootPhase = () => use(RouterBootPhaseContext);

/**
 * Suspense fallback for lazily-loaded route elements: the boot splash during
 * boot, the inline (container-sized) loader afterwards.
 */
export const RouteFallback = ({ debugId }: { debugId: string }) => {
  const bootPhase = useRouterBootPhase();
  const isBooting = useSyncExternalStore(
    bootPhase.subscribe,
    bootPhase.isBooting,
    bootPhase.isBooting,
  );

  useEffect(() => bootPhase.retainFallback(), [bootPhase]);

  return <Loading debugId={debugId} variant={isBooting ? 'fullscreen' : 'inline'} />;
};

/**
 * Wraps a lazily-loaded route element. Mounting means that route's chunk is on
 * screen, so it asks the phase to settle; the ref-count keeps boot alive when a
 * nested route below it is still pending.
 */
export const BootPhaseRouteMarker = ({ children }: { children: ReactNode }) => {
  const bootPhase = useRouterBootPhase();

  useEffect(() => {
    bootPhase.settleIfIdle();
  }, [bootPhase]);

  return children;
};
