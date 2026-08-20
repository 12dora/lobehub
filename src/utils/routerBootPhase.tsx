'use client';

import { createContext, type ReactNode, use, useEffect, useSyncExternalStore } from 'react';
import { useLocation, useNavigation } from 'react-router';

import BootSplashOverlay from '@/components/Loading/BootSplashOverlay';
import Loading from '@/components/Loading/BrandTextLoading';

/**
 * Boot phase for one router instance.
 *
 * "Boot" is the window between the SPA mounting and the *initially matched leaf
 * route* being on screen. During it, one root-level fixed overlay
 * ({@link BootSplashOverlay}) covers the app, continuing `index.html`'s static
 * splash. Route-level Suspense fallbacks are always the inline (container-sized)
 * loader — a nested fallback can never be a credible full-screen splash, because
 * by the time it renders the layout chunk has landed and it is boxed inside the
 * layout container with the app chrome painted around it.
 *
 * Settlement requires all of:
 *
 * 1. **The outlet is live** — nothing settles while `CacheHydrationGate` is still
 *    blocking, otherwise boot would end before any route content exists.
 * 2. **No pending route fallback** — ref-counted, so a cold deep link keeps the
 *    splash while the leaf below an already-resolved layout is still loading.
 * 3. **The router is idle at a location that has been stable for two frames** —
 *    a synchronous redirect route (`/settings` → `/settings/profile`) commits a
 *    `<Navigate>` in the very commit that releases the layout's fallback, so a
 *    same-tick check would settle before the redirected leaf exists. Every
 *    retain, release, location change and navigation re-arms the check.
 *
 * It is created per router instance, so recreating the router (HMR, a second
 * desktop window, tests) restores the splash instead of inheriting a settled
 * module-global latch.
 */
export interface RouterBootPhase {
  /** Cancel any armed settlement check (a navigation is in flight). */
  holdSettle: () => void;
  /** True until the initially matched leaf route has committed. */
  isBooting: () => boolean;
  /** The router outlet is mounted and rendering route content. */
  markOutletReady: () => void;
  /** (Re-)arm the settlement check. */
  requestSettle: () => void;
  /** Ref-count a pending route fallback. Returns the release function. */
  retainFallback: () => () => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * Two frames, not one: React commits a redirect-driven route in a scheduler
 * task whose ordering against a single `requestAnimationFrame` is not
 * guaranteed. Falls back to timers where `requestAnimationFrame` is absent.
 */
const scheduleStableFrames = (callback: () => void): (() => void) => {
  if (typeof requestAnimationFrame !== 'function') {
    const outer = setTimeout(() => {
      inner = setTimeout(callback, 0);
    }, 0);
    let inner: ReturnType<typeof setTimeout> | undefined;
    return () => {
      clearTimeout(outer);
      if (inner) clearTimeout(inner);
    };
  }

  let innerFrame: number | undefined;
  const outerFrame = requestAnimationFrame(() => {
    innerFrame = requestAnimationFrame(callback);
  });

  return () => {
    cancelAnimationFrame(outerFrame);
    if (innerFrame !== undefined) cancelAnimationFrame(innerFrame);
  };
};

export const createRouterBootPhase = (): RouterBootPhase => {
  let booting = true;
  let pending = 0;
  let outletReady = false;
  let cancelArmed: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const holdSettle = () => {
    cancelArmed?.();
    cancelArmed = null;
  };

  const finish = () => {
    booting = false;
    listeners.forEach((listener) => listener());
  };

  const requestSettle = () => {
    if (!booting) return;
    holdSettle();
    if (!outletReady || pending > 0) return;

    cancelArmed = scheduleStableFrames(() => {
      cancelArmed = null;
      if (!booting || !outletReady || pending > 0) return;
      finish();
    });
  };

  return {
    holdSettle,
    isBooting: () => booting,
    markOutletReady: () => {
      outletReady = true;
      requestSettle();
    },
    requestSettle,
    retainFallback: () => {
      pending += 1;
      // Cancels an armed check that would otherwise fire while this boundary is
      // still suspended.
      requestSettle();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending -= 1;
        requestSettle();
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/**
 * Default for trees rendered outside a router (isolated component tests,
 * Storybook): already settled, so nothing can paint a stray boot splash.
 */
const SETTLED_BOOT_PHASE: RouterBootPhase = {
  holdSettle: () => {},
  isBooting: () => false,
  markOutletReady: () => {},
  requestSettle: () => {},
  retainFallback: () => () => {},
  subscribe: () => () => {},
};

export const RouterBootPhaseContext = createContext<RouterBootPhase>(SETTLED_BOOT_PHASE);

export const useRouterBootPhase = () => use(RouterBootPhaseContext);

const useIsBooting = (bootPhase: RouterBootPhase) =>
  useSyncExternalStore(bootPhase.subscribe, bootPhase.isBooting, bootPhase.isBooting);

/** Suspense fallback for lazily-loaded route elements — always inline. */
export const RouteFallback = ({ debugId }: { debugId: string }) => {
  const bootPhase = useRouterBootPhase();

  useEffect(() => bootPhase.retainFallback(), [bootPhase]);

  return <Loading debugId={debugId} variant={'inline'} />;
};

/** The root-level splash, shown for as long as the phase is booting. */
export const RouterBootSplash = () => {
  const bootPhase = useRouterBootPhase();
  const isBooting = useIsBooting(bootPhase);

  if (!isBooting) return null;

  return <BootSplashOverlay />;
};

/**
 * Re-arms settlement whenever the committed location or the navigation state
 * changes, and holds it while a navigation is in flight. Must live inside the
 * data router but outside any hydration gate.
 */
export const RouterBootSettler = () => {
  const bootPhase = useRouterBootPhase();
  const location = useLocation();
  const navigation = useNavigation();

  useEffect(() => {
    if (navigation.state !== 'idle') {
      bootPhase.holdSettle();
      return;
    }
    bootPhase.requestSettle();
  }, [bootPhase, location.key, location.pathname, navigation.state]);

  return null;
};

/**
 * Rendered next to the router `<Outlet />`, i.e. only once the hydration gate
 * has released and route content is actually being rendered.
 */
export const BootPhaseOutletMarker = () => {
  const bootPhase = useRouterBootPhase();

  useEffect(() => {
    bootPhase.markOutletReady();
  }, [bootPhase]);

  return null;
};

/**
 * Boot wiring shared by the production router root and its tests: the phase
 * context, the root splash and the location-aware settler.
 */
export const RouterBootRoot = ({
  bootPhase,
  children,
}: {
  bootPhase: RouterBootPhase;
  children: ReactNode;
}) => (
  <RouterBootPhaseContext value={bootPhase}>
    <RouterBootSplash />
    <RouterBootSettler />
    {children}
  </RouterBootPhaseContext>
);
