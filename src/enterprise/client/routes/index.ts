import type { RouteObject } from 'react-router';

import { enterpriseModuleRegistry } from '../registry';

/**
 * Enterprise desktop routes without main layout.
 * Empty while no modules register routes (default: all flags off / M00 skeleton).
 */
export const getEnterpriseDesktopRoutesWithoutMainLayout = (): RouteObject[] =>
  enterpriseModuleRegistry.getRoutes();

/**
 * Static export used by BusinessDesktopRoutes mount.
 * Intentionally empty: modules register into the registry; M03 will gate admin shell
 * on ENABLE_PLATFORM_ADMIN. Spreading this array must not change the upstream route tree.
 */
export const EnterpriseDesktopRoutesWithoutMainLayout: RouteObject[] = [];
