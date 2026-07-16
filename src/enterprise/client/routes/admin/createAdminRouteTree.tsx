import { lazy, type ReactNode, Suspense } from 'react';
import type { RouteObject } from 'react-router';

import AdminErrorBoundary from '@/enterprise/client/features/admin/gates/AdminErrorBoundary';
import AdminRootGate from '@/enterprise/client/features/admin/gates/AdminRootGate';
import NotFoundPage from '@/enterprise/client/features/admin/pages/NotFoundPage';
import OverviewPage from '@/enterprise/client/features/admin/pages/OverviewPage';
import PlaceholderPage from '@/enterprise/client/features/admin/pages/PlaceholderPage';
import { ADMIN_NAV_FLAT } from '@/enterprise/client/nav/adminNavMeta';

const UsersListPage = lazy(() => import('@/enterprise/client/features/admin/users/UsersListPage'));
const UserDetailPage = lazy(
  () => import('@/enterprise/client/features/admin/users/UserDetailPage'),
);

const LazyFallback = () => null;

const withLazy = (node: ReactNode) => <Suspense fallback={<LazyFallback />}>{node}</Suspense>;

/** Resolve the page element for a catalog item (M04 users are real; others stay placeholders). */
const resolveAdminLeafElement = (id: string): ReactNode => {
  switch (id) {
    case 'users': {
      return withLazy(<UsersListPage />);
    }
    case 'users-detail': {
      return withLazy(<UserDetailPage />);
    }
    default: {
      return <PlaceholderPage />;
    }
  }
};

/**
 * Build the independent `/admin` route tree (no main-app layout nesting).
 * Paths come from the same nav metadata catalog used for menus and guards.
 */
export const createAdminRouteTree = (): RouteObject[] => {
  const leafPaths = ADMIN_NAV_FLAT.filter((item) => item.path !== '/admin').map((item) => {
    // Convert absolute /admin/foo to relative foo under the /admin parent
    // Preserve :param segments for React Router
    const relative = item.path.replace(/^\/admin\/?/, '');
    return {
      element: resolveAdminLeafElement(item.id),
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
