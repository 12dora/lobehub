import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import {
  MANAGED_RESOURCE_KINDS,
  type ManagedResourceKind,
} from '@/const/platform/managedResources';
import {
  createUnmanagedResourcePolicyMap,
  isManagedResourceFeatureEnabled,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { ManagedResourcesCapabilities } from '@/types/platform/capabilities';
import type {
  ManagedResourcePolicyMap,
  ManagedResourceReadinessMap,
} from '@/types/platform/managedResources';

import { resolveManagedResourceReadiness } from './managedResourceReadiness';

export interface ResolvedManagedResourcePolicies {
  publicCapabilities: ManagedResourcesCapabilities;
  published: ManagedResourcePolicyMap;
  readiness: ManagedResourceReadinessMap;
  revision: number;
}

export const resolvePublishedManagedResourcePolicies = async (params: {
  db: LobeChatDatabase;
  flags: EnterpriseFeatureFlags;
  readiness?: () => Promise<ManagedResourceReadinessMap>;
}): Promise<ResolvedManagedResourcePolicies> => {
  const [snapshot, readiness] = await Promise.all([
    new PlatformManagedResourcePolicyModel(params.db).getSnapshot(),
    (params.readiness ?? resolveManagedResourceReadiness)(),
  ]);
  const published =
    snapshot.status === 'published' ? snapshot.published : createUnmanagedResourcePolicyMap();
  const publicCapabilities = {} as ManagedResourcesCapabilities;

  for (const resource of MANAGED_RESOURCE_KINDS) {
    const policy = published[resource];
    const featureOn = isManagedResourceFeatureEnabled(resource, params.flags);
    const catalogSafe = policy.enforcementMode !== 'enforced' || readiness[resource];
    publicCapabilities[resource] =
      featureOn && policy.managed && policy.enforcementMode !== 'observe' && catalogSafe;
  }

  return { publicCapabilities, published, readiness, revision: snapshot.revision };
};

export const isPublishedResourceManaged = (
  resolved: ResolvedManagedResourcePolicies,
  resource: ManagedResourceKind,
): boolean => resolved.publicCapabilities[resource];
