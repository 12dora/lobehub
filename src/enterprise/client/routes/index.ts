import type { RouteObject } from 'react-router';

import { isPlatformAdminBootEnabled } from '../boot/isPlatformAdminBootEnabled';
import { enterpriseModuleRegistry } from '../registry';
import { createAdminRouteTree } from './admin/createAdminRouteTree';

/**
 * Enterprise desktop routes for BusinessDesktopRoutesWithoutMainLayout.
 *
 * Flag-off (boot `enterprise.platformAdmin` false/absent): returns **no** `/admin`
 * RouteObject — the path is not registered. Flag-on: full admin tree for deep links.
 *
 * Boot source: `window.__SERVER_CONFIG__` only (synchronous HTML inject).
 */
export const getEnterpriseDesktopRoutesWithoutMainLayout = (): RouteObject[] => {
  const moduleRoutes = enterpriseModuleRegistry.getRoutes();
  if (!isPlatformAdminBootEnabled()) {
    return [...moduleRoutes];
  }
  return [...createAdminRouteTree(), ...moduleRoutes];
};

/**
 * Static export evaluated at SPA module load (after `__SERVER_CONFIG__` inject).
 * When platform admin is off, this array does not contain `/admin`.
 */
export const EnterpriseDesktopRoutesWithoutMainLayout: RouteObject[] =
  getEnterpriseDesktopRoutesWithoutMainLayout();

/**
 * Mobile `/admin` surface: unsupported management page when flag on; empty when off.
 */
export const getEnterpriseMobileRoutesWithoutMainLayout = (): RouteObject[] => {
  if (!isPlatformAdminBootEnabled()) return [];
  // Lazy element import kept in BusinessMobileRoutes to avoid circular deps in tests
  return [];
};

export { isPlatformAdminBootEnabled } from '../boot/isPlatformAdminBootEnabled';
export { createAdminRouteTree } from './admin/createAdminRouteTree';
