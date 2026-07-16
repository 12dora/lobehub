import type { RouteObject } from 'react-router';

import AdminErrorBoundary from '@/enterprise/client/features/admin/gates/AdminErrorBoundary';
import AdminRootGate from '@/enterprise/client/features/admin/gates/AdminRootGate';
import NotFoundPage from '@/enterprise/client/features/admin/pages/NotFoundPage';
import OverviewPage from '@/enterprise/client/features/admin/pages/OverviewPage';
import PlaceholderPage from '@/enterprise/client/features/admin/pages/PlaceholderPage';
import { ADMIN_NAV_FLAT } from '@/enterprise/client/nav/adminNavMeta';

/**
 * Build the independent `/admin` route tree (no main-app layout nesting).
 * Paths come from the same nav metadata catalog used for menus and guards.
 */
export const createAdminRouteTree = (): RouteObject[] => {
  const leafPaths = ADMIN_NAV_FLAT.filter((item) => item.path !== '/admin').map((item) => {
    // Convert absolute /admin/foo to relative foo under the /admin parent
    const relative = item.path.replace(/^\/admin\/?/, '');
    return {
      element: <PlaceholderPage />,
      handle: {
        admin: {
          id: item.id,
          placeholder: item.placeholder ?? false,
          requiredPermissions: item.requiredPermissions,
        },
      },
      path: relative,
    } satisfies RouteObject;
  });

  // Nested AI group: register both ai and ai/* (providers/models already as flat relatives)
  // identity/providers is already relative "identity/providers"

  return [
    {
      children: [
        {
          element: <OverviewPage />,
          handle: {
            admin: {
              id: 'overview',
              placeholder: false,
              requiredPermissions: [],
            },
          },
          index: true,
        },
        ...leafPaths,
        {
          element: <NotFoundPage />,
          path: '*',
        },
      ],
      element: (
        <AdminErrorBoundary>
          <AdminRootGate />
        </AdminErrorBoundary>
      ),
      path: '/admin',
    },
  ];
};

/**
 * Effective enterprise desktop routes for a given boot-config snapshot.
 * When `platformAdmin` is false, returns [] so `/admin` is absent from the tree.
 */
export const resolveEnterpriseDesktopRoutes = (options: {
  platformAdmin: boolean;
}): RouteObject[] => {
  if (!options.platformAdmin) return [];
  return createAdminRouteTree();
};
