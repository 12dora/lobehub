'use client';

import { memo } from 'react';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { useManagedResource } from '@/features/ManagedResources';
import { ToolSettings } from '@/routes/(main)/settings/skill';

const Page = memo(() => {
  const { error, loading, managed, refresh } = useManagedResource('connectors');

  if (error) return <AsyncError error={error} variant="page" onRetry={() => void refresh()} />;
  if (loading) return <Loading debugId="Settings > Connector > Managed policy" />;

  return <ToolSettings managed={managed} viewMode="connector" />;
});

Page.displayName = 'ConnectorSettings';

export default Page;
