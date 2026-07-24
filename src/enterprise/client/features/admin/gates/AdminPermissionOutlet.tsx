'use client';

import { memo } from 'react';
import { Outlet, useLocation, useMatches } from 'react-router';

import {
  canAccessAdminPath,
  findAdminNavItemByPath,
  hasAllPermissions,
} from '@/enterprise/client/nav/adminNavMeta';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { AdminNotFoundSurface, AdminPageForbiddenSurface } from '../pages/AdminStateSurfaces';

type AdminRouteHandle = {
  admin?: {
    requiredPermissions?: readonly string[];
  };
};

const readRequiredPermissions = (handle: unknown): readonly string[] | null => {
  if (!handle || typeof handle !== 'object') return null;
  const admin = (handle as AdminRouteHandle).admin;
  if (!admin || !Array.isArray(admin.requiredPermissions)) return null;
  return admin.requiredPermissions;
};

/**
 * Renders child routes only when the user has the path's declared permissions.
 * Catalog paths use nav metadata; registry extension routes use `handle.admin`.
 * Unknown paths under /admin → scoped 404. Missing permission → page 403.
 * No child data mounts until parent access is `allowed` (provider gate).
 *
 * Uses data-router `useMatches()` (production SPA + createMemoryRouter tests).
 * Extension routes: union `requiredPermissions` across every matched handle so a
 * nested child with `[]` cannot override a permission-bearing parent.
 */
const AdminPermissionOutlet = memo(() => {
  const { permissions, status } = useAdminAccess();
  const location = useLocation();
  const matches = useMatches();

  if (status !== 'allowed') {
    return null;
  }

  const pathname = location.pathname.replace(/\/+$/, '') || '/admin';
  const item = findAdminNavItemByPath(pathname);

  // Catalog entry wins (same source as sidebar + canAccessAdminPath).
  if (item) {
    if (!canAccessAdminPath(pathname, permissions)) {
      return <AdminPageForbiddenSurface />;
    }
    return <Outlet />;
  }

  // Extension / module routes: union permissions from every matched handle.
  const requiredUnion: string[] = [];
  let sawExtensionHandle = false;
  for (const match of matches) {
    const required = readRequiredPermissions(match?.handle);
    if (!required) continue;
    sawExtensionHandle = true;
    for (const permission of required) {
      if (!requiredUnion.includes(permission)) {
        requiredUnion.push(permission);
      }
    }
  }

  if (sawExtensionHandle) {
    if (!hasAllPermissions(permissions, requiredUnion)) {
      return <AdminPageForbiddenSurface />;
    }
    return <Outlet />;
  }

  // Paths not in the admin catalog and without extension handle → scoped 404.
  return <AdminNotFoundSurface />;
});

AdminPermissionOutlet.displayName = 'AdminPermissionOutlet';

export default AdminPermissionOutlet;
