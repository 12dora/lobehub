import type { ManagedResourceKind } from '@/const/platform/managedResources';
import type { ManagedResourcesCapabilities } from '@/types/platform/capabilities';

export const MANAGED_RESOURCE_BY_SETTINGS_TAB = {
  'connector': 'connectors',
  'provider': 'aiProviders',
  'service-model': 'aiModels',
  'skill': 'skills',
} as const satisfies Record<string, ManagedResourceKind>;

export const MANAGED_RESOURCE_BROWSE_ROUTE = {
  agents: '/community/agent',
  aiModels: '/community/model',
  aiProviders: '/community/provider',
  connectors: '/community/mcp',
  skills: '/community/skill',
} as const satisfies Record<ManagedResourceKind, string>;

export const getManagedResourceBrowseRoute = (resource: ManagedResourceKind): string =>
  MANAGED_RESOURCE_BROWSE_ROUTE[resource];

export const getManagedResourceForSettingsTab = (
  tab: string | undefined,
): ManagedResourceKind | undefined => {
  if (!tab) return undefined;
  return MANAGED_RESOURCE_BY_SETTINGS_TAB[tab as keyof typeof MANAGED_RESOURCE_BY_SETTINGS_TAB];
};

export const isSettingsTabManaged = (
  tab: string | undefined,
  capabilities: ManagedResourcesCapabilities,
): boolean => {
  const resource = getManagedResourceForSettingsTab(tab);
  return resource ? capabilities[resource] : false;
};

export const isManagedResourceConfigurationAvailable = (
  resource: ManagedResourceKind,
  snapshot: {
    capabilities: ManagedResourcesCapabilities;
    error: Error | null;
    loading: boolean;
  },
): boolean => !snapshot.loading && !snapshot.error && !snapshot.capabilities[resource];
