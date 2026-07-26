'use client';

import type { ReactNode } from 'react';
import { memo } from 'react';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { ManagedResourceTransition, useManagedResource } from '@/features/ManagedResources';

import PlatformConnectorAuthorization from './PlatformConnectorAuthorization';

interface ManagedConnectorSettingsProps {
  fallback: ReactNode;
}

/**
 * Managed Connectors still require each user to authorize per-user OAuth credentials.
 * Keep that authorization surface on the canonical Connector settings route while
 * preserving the ordinary Tool settings fallback for unmanaged deployments.
 */
const ManagedConnectorSettings = memo<ManagedConnectorSettingsProps>(({ fallback }) => {
  const { error, loading, managed, refresh } = useManagedResource('connectors');

  const state = error ? 'error' : loading ? 'loading' : managed ? 'managed' : 'content';
  const content = error ? (
    <AsyncError error={error} variant="page" onRetry={() => void refresh()} />
  ) : loading ? (
    <Loading debugId="ManagedConnectorSettings" />
  ) : managed ? (
    <PlatformConnectorAuthorization />
  ) : (
    fallback
  );

  return <ManagedResourceTransition state={state}>{content}</ManagedResourceTransition>;
});

ManagedConnectorSettings.displayName = 'ManagedConnectorSettings';

export default ManagedConnectorSettings;
