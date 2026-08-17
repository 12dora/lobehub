'use client';

import { memo } from 'react';

import type { PlatformModuleId } from '@/const/platform/modules';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { useAdminModules } from '../modules/useAdminModules';
import { AdminModuleDisabledSurface } from '../pages/AdminStateSurfaces';

export interface ModuleDisabledRouteProps {
  moduleId: PlatformModuleId;
}

/**
 * Connected wrapper for `AdminModuleDisabledSurface`.
 *
 * The one thing the surface cannot know on its own is *which* env variable pinned the module
 * off, and that is exactly the difference between "click here to switch it back on" and
 * "editing the console will not help". The lookup rides the same SWR cache as the modules page,
 * so it costs at most one request on a page that is only reached by a disabled deep link, and
 * degrades to the generic call-to-action when the admin cannot read system settings.
 */
const ModuleDisabledRoute = memo<ModuleDisabledRouteProps>(({ moduleId }) => {
  const { permissions, status } = useAdminAccess();
  const canRead = permissions.includes(PLATFORM_PERMISSIONS.SYSTEM_READ);
  const { data } = useAdminModules(status === 'allowed' && canRead);

  return (
    <AdminModuleDisabledSurface
      envVariable={data?.snapshot.envDisabledBy[moduleId] ?? null}
      moduleId={moduleId}
    />
  );
});

ModuleDisabledRoute.displayName = 'AdminModuleDisabledRoute';

export default ModuleDisabledRoute;
