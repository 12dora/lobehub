import { type RouteObject } from 'react-router';

import { isPlatformAdminBootEnabled } from '@/enterprise/client/boot/isPlatformAdminBootEnabled';
import { AdminMobileUnsupportedSurface } from '@/enterprise/client/features/admin/pages/AdminStateSurfaces';

export const BusinessMobileRoutesWithMainLayout: RouteObject[] = [];
export const BusinessMobileRoutesWithSettingsLayout: RouteObject[] = [];

/**
 * Mobile: when platform admin is on, deep links hit an explicit unsupported surface.
 * When flag is off, `/admin` is not registered at all.
 */
export const BusinessMobileRoutesWithoutMainLayout: RouteObject[] = isPlatformAdminBootEnabled()
  ? [
      {
        element: <AdminMobileUnsupportedSurface />,
        path: '/admin/*',
      },
      {
        element: <AdminMobileUnsupportedSurface />,
        path: '/admin',
      },
    ]
  : [];
