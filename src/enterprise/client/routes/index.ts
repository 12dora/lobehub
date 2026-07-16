import type { RouteObject } from 'react-router';

import { enterpriseModuleRegistry } from '../registry';
import { createAdminRouteTree } from './admin/createAdminRouteTree';

/**
 * Dynamic routes from the module registry + admin shell.
 *
 * Flag-off effective tree: use `resolveEnterpriseDesktopRoutes({ platformAdmin: false })`
 * which returns []. Production mount uses a gated tree: routes exist so deep links resolve
 * after SPA boot, but the gate never calls `admin.*` when boot config says platformAdmin is off.
 */
export const getEnterpriseDesktopRoutesWithoutMainLayout = (): RouteObject[] => [
  ...createAdminRouteTree(),
  ...enterpriseModuleRegistry.getRoutes(),
];

/**
 * Static export used by BusinessDesktopRoutes mount.
 * Admin shell is included; feature + RBAC gates keep flag-off and unauthorized users safe.
 */
export const EnterpriseDesktopRoutesWithoutMainLayout: RouteObject[] =
  getEnterpriseDesktopRoutesWithoutMainLayout();

export { createAdminRouteTree, resolveEnterpriseDesktopRoutes } from './admin/createAdminRouteTree';
