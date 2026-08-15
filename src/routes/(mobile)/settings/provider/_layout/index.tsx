'use client';

import { Outlet, useParams } from 'react-router';

import { ManagedResourceBoundary } from '@/features/ManagedResources';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';

import ProviderMenu from '../../../../(main)/settings/provider/ProviderMenu';

const Layout = () => {
  const params = useParams<{ providerId: string }>();
  const navigate = useWorkspaceAwareNavigate();

  const handleProviderSelect = (providerKey: string) => {
    navigate(`/settings/provider/${providerKey}`);
  };

  return (
    <ManagedResourceBoundary resource="aiProviders">
      {params.providerId === 'all' ? (
        <ProviderMenu mobile={true} onProviderSelect={handleProviderSelect} />
      ) : (
        <Outlet />
      )}
    </ManagedResourceBoundary>
  );
};

export default Layout;
