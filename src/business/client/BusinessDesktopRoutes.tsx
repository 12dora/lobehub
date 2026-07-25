import { type RouteObject } from 'react-router';

import { getEnterpriseDesktopRoutesWithoutMainLayout } from '@/enterprise/client/routes';

export const BusinessDesktopRoutesWithMainLayout: RouteObject[] = [];
export const BusinessDesktopRoutesWithSettingsLayout: RouteObject[] = [];

/**
 * Enterprise admin shell routes from the in-process registry snapshot.
 * Flag-off returns [] — `/admin` is not in the route tree.
 *
 * Dynamic `enterpriseModuleRegistry.register` is **not** a supported public
 * API for live route injection: `desktopRoutes` freezes this getter's result
 * at module-evaluation time. Extension modules need a future factory rebuild.
 */
export const getBusinessDesktopRoutesWithoutMainLayout = (): RouteObject[] =>
  getEnterpriseDesktopRoutesWithoutMainLayout();

/**
 * Boot-time snapshot for consumers that import after setting
 * `window.__SERVER_CONFIG__` (e.g. flag-off regression tests with resetModules).
 */
export const BusinessDesktopRoutesWithoutMainLayout: RouteObject[] =
  getBusinessDesktopRoutesWithoutMainLayout();
