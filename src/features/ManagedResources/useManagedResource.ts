'use client';

import type { ManagedResourceKind } from '@/const/platform/managedResources';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';

export const useManagedResourceCapabilities = () => {
  const platform = useEnterprisePlatform();
  return {
    capabilities: platform.capabilities.managedResources,
    error: platform.error,
    loading: platform.loading,
  };
};

export const useManagedResource = (resource: ManagedResourceKind) => {
  const platform = useEnterprisePlatform();
  return {
    blocked:
      platform.loading ||
      platform.error !== null ||
      platform.capabilities.managedResources[resource] === true,
    error: platform.error,
    loading: platform.loading,
    managed: platform.capabilities.managedResources[resource] === true,
    refresh: platform.refresh,
  };
};
