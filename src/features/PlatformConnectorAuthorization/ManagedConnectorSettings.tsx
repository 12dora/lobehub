'use client';

import type { ReactNode } from 'react';
import { memo } from 'react';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { ManagedResourceTransition, useManagedResource } from '@/features/ManagedResources';
import SettingContainer from '@/features/Setting/SettingContainer';

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
    // Document-flow page, not the master-detail catalog the unmanaged fallback
    // renders: it needs its own scroller because the settings pane is
    // `overflow: hidden`.
    <SettingContainer flex={1} maxWidth={1024} paddingInline={24} style={{ minHeight: 0 }}>
      <PlatformConnectorAuthorization />
    </SettingContainer>
  ) : (
    fallback
  );

  return <ManagedResourceTransition state={state}>{content}</ManagedResourceTransition>;
});

ManagedConnectorSettings.displayName = 'ManagedConnectorSettings';

export default ManagedConnectorSettings;
