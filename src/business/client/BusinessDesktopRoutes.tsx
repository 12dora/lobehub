import { type RouteObject } from 'react-router';

import { EnterpriseDesktopRoutesWithoutMainLayout } from '@/enterprise/client/routes';

export const BusinessDesktopRoutesWithMainLayout: RouteObject[] = [];
export const BusinessDesktopRoutesWithSettingsLayout: RouteObject[] = [];

/**
 * Enterprise admin shell routes register here only when boot
 * `enterprise.platformAdmin` is true (see EnterpriseDesktopRoutesWithoutMainLayout).
 * Flag-off: empty — `/admin` is not in the route tree.
 */
export const BusinessDesktopRoutesWithoutMainLayout: RouteObject[] = [
  ...EnterpriseDesktopRoutesWithoutMainLayout,
];
