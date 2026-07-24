import type { RouteObject } from 'react-router';

import { isPlatformAdminBootEnabled } from '../boot/isPlatformAdminBootEnabled';
import { AdminMobileUnsupportedSurface } from '../features/admin/pages/AdminStateSurfaces';

/**
 * Mobile enterprise routes for BusinessMobileRoutesWithoutMainLayout.
 * Flag-off: empty. Flag-on: explicit unsupported surface for /admin deep links.
 */
export const getEnterpriseMobileRoutesWithoutMainLayout = (): RouteObject[] => {
  if (!isPlatformAdminBootEnabled()) return [];
  return [
    {
      element: <AdminMobileUnsupportedSurface />,
      path: '/admin/*',
    },
    {
      element: <AdminMobileUnsupportedSurface />,
      path: '/admin',
    },
  ];
};
