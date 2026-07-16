'use client';

import { memo, useEffect } from 'react';

import AdminAccessProvider, {
  useAdminAccess,
} from '@/enterprise/client/providers/AdminAccessProvider';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useServerConfigStore } from '@/store/serverConfig';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/slices/auth/selectors';

import AdminShellLayout from '../layout/AdminShellLayout';
import {
  AdminAccessErrorSurface,
  AdminFeatureOffSurface,
  AdminForbiddenSurface,
  AdminLoadingSurface,
  AdminMobileUnsupportedSurface,
  AdminSignInRedirectSurface,
} from '../pages/AdminStateSurfaces';
import AdminPermissionOutlet from './AdminPermissionOutlet';

/**
 * Boot + auth + access gate for `/admin`.
 *
 * Order:
 * 1. Wait for global config (`platformAdmin` feature existence).
 * 2. Feature off → no `admin.*` requests; unavailable surface.
 * 3. Wait for auth session; anonymous → canonical sign-in with return path.
 * 4. Authenticated → AdminAccessProvider (`getMyAccess`); forbidden / error / shell.
 */
const AdminRootGate = memo(() => {
  const isMobile = useIsMobile();
  const serverConfigInit = useServerConfigStore((s) => s.serverConfigInit);
  const platformAdmin = useServerConfigStore(
    (s) => s.serverConfig.enterprise?.platformAdmin === true,
  );
  const isAuthLoaded = useUserStore(authSelectors.isLoaded);
  const isLogin = useUserStore(authSelectors.isLogin);
  const openLogin = useUserStore((s) => s.openLogin);

  useEffect(() => {
    if (!serverConfigInit || !platformAdmin) return;
    if (!isAuthLoaded) return;
    if (isLogin) return;
    void openLogin();
  }, [serverConfigInit, platformAdmin, isAuthLoaded, isLogin, openLogin]);

  if (!serverConfigInit) {
    return <AdminLoadingSurface />;
  }

  // Feature flag off: zero admin.* requests
  if (!platformAdmin) {
    return <AdminFeatureOffSurface />;
  }

  if (isMobile) {
    return <AdminMobileUnsupportedSurface />;
  }

  if (!isAuthLoaded) {
    return <AdminLoadingSurface />;
  }

  if (!isLogin) {
    return <AdminSignInRedirectSurface />;
  }

  return (
    <AdminAccessProvider>
      <AdminAccessShell />
    </AdminAccessProvider>
  );
});

AdminRootGate.displayName = 'AdminRootGate';

const AdminAccessShell = memo(() => {
  const { status, refresh, retryable } = useAdminAccess();

  if (status === 'loading') {
    return <AdminLoadingSurface />;
  }

  if (status === 'forbidden') {
    return <AdminForbiddenSurface />;
  }

  if (status === 'error') {
    return (
      <AdminAccessErrorSurface
        retryable={retryable}
        onRetry={retryable ? () => void refresh() : undefined}
      />
    );
  }

  // status === 'allowed'
  return (
    <AdminShellLayout>
      <AdminPermissionOutlet />
    </AdminShellLayout>
  );
});

AdminAccessShell.displayName = 'AdminAccessShell';

export default AdminRootGate;
