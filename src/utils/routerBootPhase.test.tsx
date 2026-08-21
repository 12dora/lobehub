import { act, render, screen, waitFor } from '@testing-library/react';
import { lazy, type ReactNode, Suspense } from 'react';
import { createMemoryRouter, Navigate, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type BootFrameScheduler,
  BootPhaseOutletMarker,
  createRouterBootPhase,
  ROUTE_FALLBACK_DELAY_MS,
  RouteFallback,
  RouterBootPhaseContext,
  RouterBootRoot,
  setBootFrameScheduler,
} from './routerBootPhase';

/**
 * Deterministic replacement for `requestAnimationFrame`: nothing runs until the
 * test flushes a frame, so the two-frame settlement window is observable.
 */
const createManualFrames = () => {
  let queue: { callback: () => void; cancelled: boolean }[] = [];

  const scheduler: BootFrameScheduler = (callback) => {
    const entry = { callback, cancelled: false };
    queue.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  /** Runs the callbacks queued so far; anything they queue waits for the next flush. */
  const flushFrame = () => {
    const current = queue;
    queue = [];
    for (const entry of current) if (!entry.cancelled) entry.callback();
  };

  const flushFrames = (count: number) => {
    for (let i = 0; i < count; i += 1) act(() => flushFrame());
  };

  return { flushFrame, flushFrames, scheduler };
};

vi.mock('@/components/Loading/BootSplashOverlay', () => ({
  default: () => <div data-testid="boot-splash" />,
}));

vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: ({ debugId, variant }: { debugId: string; variant?: string }) => (
    <div data-debug-id={debugId} data-testid="route-fallback" data-variant={variant} />
  ),
}));

/** A lazily-loaded route element whose chunk resolves only when told to. */
const deferredRoute = (testId: string, children?: ReactNode) => {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });

  const Component = lazy(async () => {
    await gate;
    return {
      default: () => (
        <div data-testid={testId}>
          {children}
          <Outlet />
        </div>
      ),
    };
  });

  return {
    element: (
      <Suspense fallback={<RouteFallback debugId={testId} />}>
        <Component />
      </Suspense>
    ),
    resolve,
  };
};

/**
 * Mirrors the production root: `RouterBootRoot` (splash + settler) outside the
 * app providers, `BootPhaseOutletMarker` next to the `<Outlet />` inside them.
 */
const renderApp = (
  routes: Parameters<typeof createMemoryRouter>[0],
  initialEntry: string,
  bootPhase = createRouterBootPhase(),
) => {
  const router = createMemoryRouter(
    [
      {
        children: routes,
        element: (
          <RouterBootRoot bootPhase={bootPhase}>
            <BootPhaseOutletMarker />
            <Outlet />
          </RouterBootRoot>
        ),
        path: '/',
      },
    ],
    { initialEntries: [initialEntry] },
  );

  bootPhase.attachRouter(router);

  return { ...render(<RouterProvider router={router} />), bootPhase, router };
};

const splash = () => screen.queryByTestId('boot-splash');

describe('boot splash topology', () => {
  it('holds one root-level splash until a cold nested leaf commits', async () => {
    const layout = deferredRoute('layout');
    const leaf = deferredRoute('leaf');

    const { bootPhase } = renderApp(
      [{ children: [{ element: leaf.element, index: true }], element: layout.element, path: 'x' }],
      '/x',
    );

    expect(splash()).toBeInTheDocument();

    // Layout chunk lands. The leaf is still loading, and its fallback now renders
    // INSIDE the committed layout — which is exactly why the splash has to be a
    // root-level overlay and the route fallback merely inline.
    layout.resolve();
    await screen.findByTestId('layout');

    // The leaf fallback is delayed, so nothing paints for the grace period; when
    // it finally does it is the inline loader, never a second splash.
    expect((await screen.findByTestId('route-fallback')).dataset.variant).toBe('inline');
    expect(splash()).toBeInTheDocument();
    expect(bootPhase.isBooting()).toBe(true);

    leaf.resolve();
    await screen.findByTestId('leaf');
    await waitFor(() => expect(splash()).not.toBeInTheDocument());
    expect(bootPhase.isBooting()).toBe(false);
  });

  it('keeps the splash across a synchronous index redirect', async () => {
    const settingsLayout = deferredRoute('settings-layout');
    const profile = deferredRoute('profile');

    const { bootPhase } = renderApp(
      [
        {
          children: [
            { element: <Navigate replace to="/settings/profile" />, index: true },
            { element: profile.element, path: 'profile' },
          ],
          element: settingsLayout.element,
          path: 'settings',
        },
      ],
      '/settings',
    );

    expect(splash()).toBeInTheDocument();

    // The layout commits `<Navigate>` in the very commit that releases its own
    // fallback: boot must not settle in that window.
    settingsLayout.resolve();
    await screen.findByTestId('settings-layout');

    expect(bootPhase.isBooting()).toBe(true);
    expect(splash()).toBeInTheDocument();

    profile.resolve();
    await screen.findByTestId('profile');
    await waitFor(() => expect(splash()).not.toBeInTheDocument());
  });

  it('keeps the splash across a workspace-settings index redirect', async () => {
    const workspaceSettings = deferredRoute('ws-settings');
    const general = deferredRoute('ws-general');

    const { bootPhase } = renderApp(
      [
        {
          children: [
            { element: <Navigate replace to="/acme/settings/general" />, index: true },
            { element: general.element, path: 'general' },
          ],
          element: workspaceSettings.element,
          path: ':workspaceSlug/settings',
        },
      ],
      '/acme/settings',
    );

    workspaceSettings.resolve();
    await screen.findByTestId('ws-settings');
    expect(bootPhase.isBooting()).toBe(true);

    general.resolve();
    await screen.findByTestId('ws-general');
    await waitFor(() => expect(splash()).not.toBeInTheDocument());
  });

  it('settles a fully synchronous route tree (popup router)', async () => {
    const { bootPhase } = renderApp(
      [{ element: <div data-testid="popup" />, path: 'popup' }],
      '/popup',
    );

    await screen.findByTestId('popup');
    await waitFor(() => expect(splash()).not.toBeInTheDocument());
    expect(bootPhase.isBooting()).toBe(false);
  });

  it('does not re-show the splash for a navigation after boot', async () => {
    const leaf = deferredRoute('leaf');
    const later = deferredRoute('later');

    const { bootPhase, router } = renderApp(
      [
        { element: leaf.element, path: 'a' },
        { element: later.element, path: 'b' },
      ],
      '/a',
    );

    leaf.resolve();
    await screen.findByTestId('leaf');
    await waitFor(() => expect(bootPhase.isBooting()).toBe(false));

    // Real post-boot navigation into a route whose chunk is not loaded yet.
    await act(async () => {
      await router.navigate('/b');
    });

    expect(router.state.location.pathname).toBe('/b');
    // `RouterProvider` wraps navigations in `startTransition`, so React holds the
    // previous route on screen instead of committing a fallback. What must hold
    // either way: the boot overlay never comes back and boot stays settled.
    expect(splash()).not.toBeInTheDocument();
    expect(bootPhase.isBooting()).toBe(false);

    // Any route fallback rendered under this (settled) phase is the inline
    // loader, never the boot splash.
    const { findByTestId, unmount } = render(
      <RouterBootPhaseContext value={bootPhase}>
        <RouteFallback debugId="post-boot" />
      </RouterBootPhaseContext>,
    );
    expect((await findByTestId('route-fallback')).dataset.variant).toBe('inline');
    unmount();

    later.resolve();
    await screen.findByTestId('later');
    expect(splash()).not.toBeInTheDocument();
    expect(bootPhase.isBooting()).toBe(false);
  });

  it('is per router instance, so a recreated router boots again', async () => {
    const first = createRouterBootPhase();
    renderApp([{ element: <div data-testid="one" />, path: 'one' }], '/one', first);
    await waitFor(() => expect(first.isBooting()).toBe(false));

    const second = createRouterBootPhase();
    expect(second.isBooting()).toBe(true);
  });
});

describe('two-frame settlement window (deterministic frames)', () => {
  afterEach(() => {
    setBootFrameScheduler(null);
  });

  it('does not settle across a synchronous redirect while the redirected leaf is unresolved', async () => {
    const frames = createManualFrames();
    setBootFrameScheduler(frames.scheduler);

    const settingsLayout = deferredRoute('settings-layout');
    const profile = deferredRoute('profile');

    const { bootPhase } = renderApp(
      [
        {
          children: [
            { element: <Navigate replace to="/settings/profile" />, index: true },
            { element: profile.element, path: 'profile' },
          ],
          element: settingsLayout.element,
          path: 'settings',
        },
      ],
      '/settings',
    );

    frames.flushFrames(2);
    expect(bootPhase.isBooting()).toBe(true);

    // The layout commits `<Navigate>` in the very commit that releases its own
    // fallback. Advance explicit frames with the redirected leaf still pending.
    settingsLayout.resolve();
    await screen.findByTestId('settings-layout');

    frames.flushFrames(2);
    expect(bootPhase.isBooting()).toBe(true);
    expect(splash()).toBeInTheDocument();

    frames.flushFrames(4);
    expect(bootPhase.isBooting()).toBe(true);
    expect(screen.queryByTestId('profile')).not.toBeInTheDocument();

    profile.resolve();
    await screen.findByTestId('profile');

    frames.flushFrames(2);
    await waitFor(() => expect(splash()).not.toBeInTheDocument());
    expect(bootPhase.isBooting()).toBe(false);
  });

  it('re-arms the full two-frame window when settlement is requested again', () => {
    const frames = createManualFrames();
    setBootFrameScheduler(frames.scheduler);

    const phase = createRouterBootPhase();
    phase.markOutletReady();

    // One frame of the first window has elapsed…
    frames.flushFrames(1);
    expect(phase.isBooting()).toBe(true);

    // …a committed location change re-requests settlement, which must restart the
    // window rather than let the half-elapsed one fire.
    phase.requestSettle();
    frames.flushFrames(1);
    expect(phase.isBooting()).toBe(true);

    frames.flushFrames(1);
    expect(phase.isBooting()).toBe(false);
  });

  it('cancels an armed window on holdSettle and can be re-armed', () => {
    const frames = createManualFrames();
    setBootFrameScheduler(frames.scheduler);

    const phase = createRouterBootPhase();
    phase.markOutletReady();

    frames.flushFrames(1);
    phase.holdSettle();

    frames.flushFrames(4);
    expect(phase.isBooting()).toBe(true);

    phase.requestSettle();
    frames.flushFrames(2);
    expect(phase.isBooting()).toBe(false);
  });

  it('cancels an armed window when a route boundary suspends again', () => {
    const frames = createManualFrames();
    setBootFrameScheduler(frames.scheduler);

    const phase = createRouterBootPhase();
    phase.markOutletReady();

    frames.flushFrames(1);

    // A nested boundary suspends before the window closes.
    const release = phase.retainFallback();
    frames.flushFrames(4);
    expect(phase.isBooting()).toBe(true);

    release();
    frames.flushFrames(2);
    expect(phase.isBooting()).toBe(false);
  });
});

describe('createRouterBootPhase', () => {
  it('never settles before the outlet is live (hydration gate still blocking)', async () => {
    const phase = createRouterBootPhase();

    phase.requestSettle();
    await new Promise((r) => setTimeout(r, 60));
    expect(phase.isBooting()).toBe(true);

    phase.markOutletReady();
    await waitFor(() => expect(phase.isBooting()).toBe(false));
  });

  it('does not settle while a fallback is pending, and re-arms on release', async () => {
    const phase = createRouterBootPhase();
    phase.markOutletReady();
    const release = phase.retainFallback();

    await new Promise((r) => setTimeout(r, 60));
    expect(phase.isBooting()).toBe(true);

    release();
    await waitFor(() => expect(phase.isBooting()).toBe(false));
  });

  it('holdSettle cancels an armed check', async () => {
    const phase = createRouterBootPhase();
    phase.markOutletReady();
    phase.holdSettle();

    await new Promise((r) => setTimeout(r, 60));
    expect(phase.isBooting()).toBe(true);
  });

  it('notifies subscribers exactly once when boot ends', async () => {
    const phase = createRouterBootPhase();
    const listener = vi.fn();
    phase.subscribe(listener);

    phase.markOutletReady();
    phase.requestSettle();
    await waitFor(() => expect(phase.isBooting()).toBe(false));
    phase.requestSettle();
    await new Promise((r) => setTimeout(r, 60));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('RouteFallback', () => {
  it('paints nothing during the grace period, then the inline loader', async () => {
    vi.useFakeTimers();
    try {
      render(<RouteFallback debugId="detached" />);

      expect(screen.queryByTestId('route-fallback')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROUTE_FALLBACK_DELAY_MS - 1);
      });
      expect(screen.queryByTestId('route-fallback')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByTestId('route-fallback').dataset.variant).toBe('inline');
    } finally {
      vi.useRealTimers();
    }
  });
});
