'use client';

import type { ReactNode } from 'react';
import { memo } from 'react';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { useManagedResource } from '@/features/ManagedResources';

import PlatformConnectorAuthorization from './PlatformConnectorAuthorization';

interface ManagedConnectorSettingsProps {
  fallback: ReactNode;
}

const ManagedConnectorSettings = memo<ManagedConnectorSettingsProps>(({ fallback }) => {
  const { error, loading, managed, refresh } = useManagedResource('connectors');

  if (error) return <AsyncError error={error} variant="page" onRetry={() => void refresh()} />;
  if (loading) return <Loading debugId="Settings > Connector > Managed policy" />;

  return managed ? <PlatformConnectorAuthorization /> : fallback;
});

ManagedConnectorSettings.displayName = 'ManagedConnectorSettings';

export default ManagedConnectorSettings;
