import type { RouteObject } from 'react-router';

import { isPlatformAdminBootEnabled } from '../boot/isPlatformAdminBootEnabled';
import { enterpriseModuleRegistry } from '../registry';
import { createAdminRouteTree } from './admin/createAdminRouteTree';

/**
 * Enterprise desktop routes for BusinessDesktopRoutesWithoutMainLayout.
 *
 * Flag-off (boot `enterprise.platformAdmin` false/absent): returns **[]** — no admin
 * shell routes and **no** registry-provided platform-admin routes either.
 * Flag-on: admin shell with registry children nested **under** AdminRootGate.
 *
 * Boot source: `window.__SERVER_CONFIG__` only (synchronous HTML inject).
 */
export const getEnterpriseDesktopRoutesWithoutMainLayout = (): RouteObject[] => {
  // Fail closed: never expose shell or registry admin routes when the feature is off.
  if (!isPlatformAdminBootEnabled()) {
    return [];
  }
  // Nest module routes under the gated /admin parent — never as top-level siblings.
  return createAdminRouteTree(enterpriseModuleRegistry.getRoutes());
};

/**
 * Static export evaluated at SPA module load (after `__SERVER_CONFIG__` inject).
 * When platform admin is off, this array is empty.
 */
export const EnterpriseDesktopRoutesWithoutMainLayout: RouteObject[] =
  getEnterpriseDesktopRoutesWithoutMainLayout();

export { isPlatformAdminBootEnabled } from '../boot/isPlatformAdminBootEnabled';
export { createAdminRouteTree } from './admin/createAdminRouteTree';
