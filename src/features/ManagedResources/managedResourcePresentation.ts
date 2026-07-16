import type { ManagedResourceKind } from '@/const/platform/managedResources';
import type { ManagedResourcesCapabilities } from '@/types/platform/capabilities';

export const MANAGED_RESOURCE_BY_SETTINGS_TAB = {
  connector: 'connectors',
  provider: 'aiProviders',
  'service-model': 'aiModels',
  skill: 'skills',
} as const satisfies Record<string, ManagedResourceKind>;

export const getManagedResourceForSettingsTab = (
  tab: string | undefined,
): ManagedResourceKind | undefined => {
  if (!tab) return undefined;
  return MANAGED_RESOURCE_BY_SETTINGS_TAB[
    tab as keyof typeof MANAGED_RESOURCE_BY_SETTINGS_TAB
  ];
};

export const isSettingsTabManaged = (
  tab: string | undefined,
  capabilities: ManagedResourcesCapabilities,
): boolean => {
  const resource = getManagedResourceForSettingsTab(tab);
  return resource ? capabilities[resource] : false;
};
