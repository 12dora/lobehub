import { type RouteObject } from 'react-router';

import { EnterpriseDesktopRoutesWithoutMainLayout } from '@/enterprise/client/routes';

export const BusinessDesktopRoutesWithMainLayout: RouteObject[] = [];
export const BusinessDesktopRoutesWithSettingsLayout: RouteObject[] = [];

/** Enterprise admin shell routes register here (empty while flags/modules are off). */
export const BusinessDesktopRoutesWithoutMainLayout: RouteObject[] = [
  ...EnterpriseDesktopRoutesWithoutMainLayout,
];
