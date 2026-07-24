import type { RouteObject } from 'react-router';

import AdminErrorBoundary from '@/enterprise/client/features/admin/gates/AdminErrorBoundary';
import AdminRootGate from '@/enterprise/client/features/admin/gates/AdminRootGate';
import NotFoundPage from '@/enterprise/client/features/admin/pages/NotFoundPage';
import { ADMIN_NAV_FLAT } from '@/enterprise/client/nav/adminNavMeta';
import { resolveAdminPage } from '@/enterprise/client/nav/adminPageCatalog';

/**
 * Build the independent `/admin` route tree (no main-app layout nesting).
 * Paths come from the same nav metadata catalog used for menus and guards.
 * Page elements come from `adminPageCatalog` (single component registry).
 *
 * @param extensionRoutes Relative (or normalized) children from enterpriseModuleRegistry.
 *   Injected **under** AdminRootGate + AdminPermissionOutlet so modules cannot bypass gates.
 */
export const createAdminRouteTree = (extensionRoutes: RouteObject[] = []): RouteObject[] => {
  const reauthComplete = ADMIN_NAV_FLAT.find((item) => item.id === 'reauth-complete');
  if (!reauthComplete) throw new Error('ADMIN_REAUTH_COMPLETE_ROUTE_MISSING');
  const leafPaths = ADMIN_NAV_FLAT.filter(
    (item) => item.path !== '/admin' && item.id !== 'reauth-complete',
  ).map((item) => {
    // Convert absolute /admin/foo to relative foo under the /admin parent.
    // Exact segment boundary only — never strip `/administrator`.
    const relative = item.path === '/admin' ? '' : item.path.replace(/^\/admin\//, '');
    const page = resolveAdminPage(item.id, item.placeholder);
    return {
      element: page.element,
      handle: {
        admin: {
          componentId: page.componentId,
          id: item.id,
          placeholder: item.placeholder ?? false,
          requiredPermissions: item.requiredPermissions,
        },
      },
      path: relative,
    } satisfies RouteObject;
  });

  const reauthPage = resolveAdminPage(reauthComplete.id, reauthComplete.placeholder);

  return [
    {
      element: <AdminErrorBoundary>{reauthPage.element}</AdminErrorBoundary>,
      handle: {
        admin: {
          componentId: reauthPage.componentId,
          id: reauthComplete.id,
          placeholder: false,
          requiredPermissions: reauthComplete.requiredPermissions,
        },
      },
      path: reauthComplete.path,
    },
    {
      children: [
        {
          element: resolveAdminPage('overview').element,
          handle: {
            admin: {
              componentId: 'OverviewPage',
              id: 'overview',
              placeholder: false,
              requiredPermissions: [],
            },
          },
          index: true,
        },
        ...leafPaths,
        // Extension modules: same parent gates as catalog leaves (never top-level siblings).
        ...extensionRoutes,
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
