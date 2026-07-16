import { type RouteObject } from 'react-router';

import { AdminMobileUnsupportedSurface } from '@/enterprise/client/features/admin/pages/AdminStateSurfaces';

export const BusinessMobileRoutesWithMainLayout: RouteObject[] = [];
export const BusinessMobileRoutesWithSettingsLayout: RouteObject[] = [];

/**
 * Mobile: deliberate unsupported-management surface for /admin deep links.
 * Does not render a shrunk desktop table admin experience.
 */
export const BusinessMobileRoutesWithoutMainLayout: RouteObject[] = [
  {
    element: <AdminMobileUnsupportedSurface />,
    path: '/admin/*',
  },
  {
    element: <AdminMobileUnsupportedSurface />,
    path: '/admin',
  },
];
