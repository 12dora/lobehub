import type { RouteObject } from 'react-router';

import { enterpriseModuleRegistry } from '../registry';

/**
 * Enterprise desktop routes without main layout.
 * Empty while no modules register routes (default: all flags off / M00 skeleton).
 */
export const getEnterpriseDesktopRoutesWithoutMainLayout = (): RouteObject[] =>
  enterpriseModuleRegistry.getRoutes();

/** Static export used by BusinessDesktopRoutes mount (flag-gated in PR-003). */
export const EnterpriseDesktopRoutesWithoutMainLayout: RouteObject[] = [];
