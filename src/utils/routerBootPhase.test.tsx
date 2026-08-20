import { render, screen, waitFor } from '@testing-library/react';
import { lazy, type ReactNode, Suspense } from 'react';
import { createMemoryRouter, Navigate, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import {
  BootPhaseOutletMarker,
  createRouterBootPhase,
  RouteFallback,
  RouterBootRoot,
} from './routerBootPhase';

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

  return { ...render(<RouterProvider router={router} />), bootPhase };
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

    expect(screen.getByTestId('route-fallback').dataset.variant).toBe('inline');
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

    const { bootPhase } = renderApp(
      [
        { element: leaf.element, path: 'a' },
        { element: later.element, path: 'b' },
      ],
      '/a',
    );

    leaf.resolve();
    await screen.findByTestId('leaf');
    await waitFor(() => expect(bootPhase.isBooting()).toBe(false));

    // A later suspension must never bring the boot overlay back.
    expect(splash()).not.toBeInTheDocument();
  });

  it('is per router instance, so a recreated router boots again', async () => {
    const first = createRouterBootPhase();
    renderApp([{ element: <div data-testid="one" />, path: 'one' }], '/one', first);
    await waitFor(() => expect(first.isBooting()).toBe(false));

    const second = createRouterBootPhase();
    expect(second.isBooting()).toBe(true);
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
  it('always renders the inline loader', () => {
    render(<RouteFallback debugId="detached" />);

    expect(screen.getByTestId('route-fallback').dataset.variant).toBe('inline');
  });
});
