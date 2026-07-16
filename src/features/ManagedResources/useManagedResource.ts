'use client';

import type { ManagedResourceKind } from '@/const/platform/managedResources';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';

export const useManagedResourceCapabilities = () =>
  useEnterprisePlatform().capabilities.managedResources;

export const useManagedResource = (resource: ManagedResourceKind) => {
  const platform = useEnterprisePlatform();
  return {
    error: platform.error,
    loading: platform.loading,
    managed: platform.capabilities.managedResources[resource] === true,
    refresh: platform.refresh,
  };
};
