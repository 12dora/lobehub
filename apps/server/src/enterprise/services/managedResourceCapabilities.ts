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
  effectiveModes: Record<ManagedResourceKind, 'unmanaged' | 'observe' | 'ui-only' | 'enforced'>;
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
  const effectiveModes = {} as ResolvedManagedResourcePolicies['effectiveModes'];

  for (const resource of MANAGED_RESOURCE_KINDS) {
    const policy = published[resource];
    const featureOn = isManagedResourceFeatureEnabled(resource, params.flags);
    // Skills must never fall back to legacy writes/runtime after enforcement was
    // published. Readiness is reported separately and the runtime fails closed;
    // silently changing the effective mode to unmanaged would reopen personal
    // mutation and name-based execution paths during a catalog outage.
    const catalogSafe =
      resource === 'skills' || policy.enforcementMode !== 'enforced' || readiness[resource];
    effectiveModes[resource] =
      featureOn && policy.managed && catalogSafe ? policy.enforcementMode : 'unmanaged';
    publicCapabilities[resource] = ['ui-only', 'enforced'].includes(effectiveModes[resource]);
  }

  return { effectiveModes, publicCapabilities, published, readiness, revision: snapshot.revision };
};

export const isPublishedResourceManaged = (
  resolved: ResolvedManagedResourcePolicies,
  resource: ManagedResourceKind,
): boolean => resolved.publicCapabilities[resource];
