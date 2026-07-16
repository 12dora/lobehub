'use client';

import { memo } from 'react';
import { Outlet, useLocation } from 'react-router';

import { canAccessAdminPath, findAdminNavItemByPath } from '@/enterprise/client/nav/adminNavMeta';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { AdminNotFoundSurface, AdminPageForbiddenSurface } from '../pages/AdminStateSurfaces';

/**
 * Renders child routes only when the user has the path's declared permissions.
 * Unknown paths under /admin → scoped 404. Missing permission → page 403.
 * No child data mounts until parent access is `allowed` (provider gate).
 */
const AdminPermissionOutlet = memo(() => {
  const { permissions, status } = useAdminAccess();
  const location = useLocation();

  if (status !== 'allowed') {
    return null;
  }

  const pathname = location.pathname.replace(/\/+$/, '') || '/admin';
  const item = findAdminNavItemByPath(pathname);

  // Paths not in the admin catalog → scoped 404 (still inside shell chrome)
  if (!item) {
    return <AdminNotFoundSurface />;
  }

  if (!canAccessAdminPath(pathname, permissions)) {
    return <AdminPageForbiddenSurface />;
  }

  return <Outlet />;
});

AdminPermissionOutlet.displayName = 'AdminPermissionOutlet';

export default AdminPermissionOutlet;
