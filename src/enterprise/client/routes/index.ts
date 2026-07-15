import type { RouteObject } from 'react-router';

import { enterpriseModuleRegistry } from '../registry';

/**
 * Dynamic routes from the module registry.
 *
 * M03 wiring plan:
 * 1. Admin shell module calls `enterpriseModuleRegistry.register({ id, routes })`.
 * 2. When `ENABLE_PLATFORM_ADMIN` is on, replace the static empty export below
 *    (or BusinessDesktopRoutes mount) with `getEnterpriseDesktopRoutesWithoutMainLayout()`
 *    so registered routes enter `BusinessDesktopRoutesWithoutMainLayout`.
 * 3. Until then this getter is unused; the **static** empty array is the real mount payload
 *    so flag-off route trees stay identical to upstream.
 */
export const getEnterpriseDesktopRoutesWithoutMainLayout = (): RouteObject[] =>
  enterpriseModuleRegistry.getRoutes();

/**
 * Static export used by BusinessDesktopRoutes mount.
 * Intentionally empty in M00: spreading this array must not change the upstream route tree.
 */
export const EnterpriseDesktopRoutesWithoutMainLayout: RouteObject[] = [];
