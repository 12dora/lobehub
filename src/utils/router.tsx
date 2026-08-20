'use client';

import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import * as m from 'motion/react-m';
import { type ComponentType, type ReactElement } from 'react';
import { lazy, memo, Suspense, useLayoutEffect } from 'react';
import type { RouteObject } from 'react-router';
import { createBrowserRouter, Navigate, Outlet, useNavigate, useRouteError } from 'react-router';

import BusinessGlobalProvider from '@/business/client/BusinessGlobalProvider';
import ErrorCapture from '@/components/Error';
import Loading from '@/components/Loading/BrandTextLoading';
import { useIsDark } from '@/hooks/useIsDark';
import SPAGlobalProvider from '@/layout/SPAGlobalProvider';
import AppLayer from '@/spa/AppLayer';
import { useGlobalStore } from '@/store/global';
import { createNavigationRef } from '@/store/global/initialState';
import { isChunkLoadError, notifyChunkError } from '@/utils/chunkError';

/**
 * False until the SPA's first lazy route chunk has resolved.
 *
 * The boot window is visually continuous with `index.html`'s static brand
 * splash, so the outermost route keeps the 100dvh `BrandTextLoading`. Every
 * suspension after that is an in-app navigation and must NOT re-show a
 * full-viewport boot splash — that is what made leaving the home page feel like
 * a full page reload. Those get the inline fallback, which fills the outlet
 * (chrome, sidebar and window frame stay put) instead of the viewport.
 */
let bootChunkResolved = false;

/** Fallback for lazily-loaded route elements. See {@link bootChunkResolved}. */
function RouteFallback({ debugId }: { debugId: string }) {
  return <Loading debugId={debugId} variant={bootChunkResolved ? 'inline' : 'fullscreen'} />;
}

async function importModule<T>(importFn: () => Promise<T>): Promise<T> {
  return importFn();
}

function resolveLazyModule<P>(module: { default: ComponentType<P> } | ComponentType<P>) {
  if (module == null) {
    throw new Error(
      'Dynamic import resolved to undefined. This usually means a chunk failed to load.',
    );
  }
  if (typeof module === 'function') {
    return { default: module };
  }
  if ('default' in module) {
    return module as { default: ComponentType<P> };
  }
  return { default: module as unknown as ComponentType<P> };
}

/**
 * Helper function to create a dynamic page element directly for router configuration
 * This eliminates the need to define const for each component
 *
 * @example
 * // Instead of:
 * // const ChatPage = dynamicPage(() => import('./chat'));
 * // element: <ChatPage />
 *
 * // You can now use:
 * // element: dynamicElement(() => import('./chat'))
 */
export function dynamicElement<P = NonNullable<unknown>>(
  importFn: () => Promise<{ default: ComponentType<P> } | ComponentType<P>>,
  debugId?: string,
): ReactElement {
  const LazyComponent = lazy(async () => {
    const mod = await importModule(importFn);
    bootChunkResolved = true;
    return resolveLazyModule(mod);
  });

  // @ts-ignore
  return (
    <Suspense fallback={<RouteFallback debugId={debugId || 'dynamicElement'} />}>
      {/* @ts-ignore */}
      <LazyComponent {...({} as P)} />
    </Suspense>
  );
}

/**
 * Helper function to create a lazy-loaded layout element for router configuration.
 * Unlike dynamicElement (for pages), layouts use Outlet so children are rendered inside.
 */
export function dynamicLayout<P = NonNullable<unknown>>(
  importFn: () => Promise<{ default: ComponentType<P> } | ComponentType<P>>,
  debugId?: string,
): ReactElement {
  const LazyComponent = lazy(async () => {
    const mod = await importModule(importFn);
    bootChunkResolved = true;
    return resolveLazyModule(mod);
  });

  // @ts-ignore
  return (
    <Suspense fallback={<RouteFallback debugId={debugId || 'dynamicLayout'} />}>
      {/* @ts-ignore */}
      <LazyComponent {...({} as P)} />
    </Suspense>
  );
}

export interface ErrorBoundaryProps {
  /** Base path for "back home" on the error screen (defaults to `/`). */
  resetPath?: string;
}

export const ErrorBoundary = ({ resetPath }: ErrorBoundaryProps) => {
  const error = useRouteError() as Error;
  const isDark = useIsDark();
  const appearance = isDark ? 'dark' : 'light';

  if (typeof window !== 'undefined' && isChunkLoadError(error)) {
    notifyChunkError();
  }

  return (
    <ThemeProvider
      appearance={appearance}
      defaultAppearance={appearance}
      defaultThemeMode={appearance}
      theme={{ cssVar: { key: 'lobe-vars' } }}
    >
      <ConfigProvider motion={m}>
        <ErrorCapture error={error} resetPath={resetPath} />
      </ConfigProvider>
    </ThemeProvider>
  );
};

/**
 * Syncs React Router's `navigate` into `navigationRef` (see `getStableNavigate` / `useStableNavigate`).
 * Mounted once on {@link RouterRoot} so imperative navigation works app-wide (desktop + mobile).
 */
export const NavigatorRegistrar = memo(() => {
  const navigate = useNavigate();

  useLayoutEffect(() => {
    useGlobalStore.setState({ navigationRef: { current: navigate } });
    return () => {
      useGlobalStore.setState({ navigationRef: createNavigationRef() });
    };
  }, [navigate]);

  return null;
});

export interface CreateAppRouterOptions {
  basename?: string;
}

const RouterRoot = memo(() => (
  <SPAGlobalProvider>
    <BusinessGlobalProvider>
      <NavigatorRegistrar />
      <AppLayer>
        <Outlet />
      </AppLayer>
    </BusinessGlobalProvider>
  </SPAGlobalProvider>
));

RouterRoot.displayName = 'RouterRoot';

/**
 * Create a React Router data router with root error boundary.
 * Use with <RouterProvider router={router} />.
 *
 * @example
 * const router = createAppRouter(desktopRoutes, { basename: '/app' });
 * createRoot(document.getElementById('root')!).render(
 *   <RouterProvider router={router} />
 * );
 */
export function createAppRouter(routes: RouteObject[], options?: CreateAppRouterOptions) {
  return createBrowserRouter(
    [
      {
        children: routes,
        element: <RouterRoot />,
        errorElement: <ErrorBoundary />,
        path: '/',
      },
    ],
    { basename: options?.basename },
  );
}

/**
 * Create a redirect element for use in route config
 * Replaces loader: () => redirect('/path') in declarative mode
 */
export function redirectElement(to: string): ReactElement {
  return <Navigate replace to={to} />;
}
