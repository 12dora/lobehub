import { MANAGED_RESOURCE_KINDS } from '@/const/platform/managedResources';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type {
  ManagedResourcePolicyMap,
  ManagedResourceReadinessMap,
} from '@/types/platform/managedResources';

export type ManagedResourceSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

export interface ManagedResourcePermissions {
  canPublish: boolean;
  canUpdate: boolean;
  canView: boolean;
}

export const deriveManagedResourcePermissions = (
  permissions: readonly string[],
): ManagedResourcePermissions => {
  const set = new Set(permissions);
  return {
    canPublish: set.has(PLATFORM_PERMISSIONS.POLICY_PUBLISH),
    canUpdate: set.has(PLATFORM_PERMISSIONS.POLICY_UPDATE),
    canView: set.has(PLATFORM_PERMISSIONS.POLICY_READ),
  };
};

export const fingerprintManagedResourcePolicy = (policy: ManagedResourcePolicyMap): string =>
  JSON.stringify(
    MANAGED_RESOURCE_KINDS.map((resource) => {
      const item = policy[resource];
      return [resource, item.managed, item.enforcementMode];
    }),
  );

export interface ManagedResourceDiff {
  after: ManagedResourcePolicyMap[keyof ManagedResourcePolicyMap];
  before: ManagedResourcePolicyMap[keyof ManagedResourcePolicyMap];
  resource: (typeof MANAGED_RESOURCE_KINDS)[number];
}

export const buildManagedResourceDiff = (
  published: ManagedResourcePolicyMap,
  draft: ManagedResourcePolicyMap,
): ManagedResourceDiff[] =>
  MANAGED_RESOURCE_KINDS.flatMap((resource) => {
    const before = published[resource];
    const after = draft[resource];
    if (
      before.managed === after.managed &&
      before.enforcementMode === after.enforcementMode
    ) {
      return [];
    }
    return [{ after, before, resource }];
  });

/** Enforced policy is publishable only after a published runtime resource is ready. */
export const getUnreadyEnforcedResources = (
  draft: ManagedResourcePolicyMap,
  readiness: ManagedResourceReadinessMap,
) =>
  MANAGED_RESOURCE_KINDS.filter(
    (resource) =>
      draft[resource].managed &&
      draft[resource].enforcementMode === 'enforced' &&
      !readiness[resource],
  );

export type ManagedResourcePrimaryAction = 'none' | 'publish' | 'retry' | 'save';

/** Exactly one primary action for the current editor state. */
export const resolveManagedResourcePrimaryAction = (params: {
  canPublish: boolean;
  canUpdate: boolean;
  conflict: boolean;
  dirty: boolean;
  hasChanges: boolean;
  publishReady: boolean;
  saveState: ManagedResourceSaveState;
}): ManagedResourcePrimaryAction => {
  if (params.conflict) return 'none';
  if (params.saveState === 'failed' && params.canUpdate) return 'retry';
  if (params.dirty && params.canUpdate) return 'save';
  if (
    !params.dirty &&
    params.hasChanges &&
    params.publishReady &&
    params.canPublish
  ) {
    return 'publish';
  }
  return 'none';
};

/** Three-way merge: local edits win only for resources changed from their original base. */
export const rebaseManagedResourceDraft = (params: {
  latest: ManagedResourcePolicyMap;
  local: ManagedResourcePolicyMap;
  original: ManagedResourcePolicyMap;
}): ManagedResourcePolicyMap => {
  return Object.fromEntries(
    MANAGED_RESOURCE_KINDS.map((resource) => {
      const original = params.original[resource];
      const local = params.local[resource];
      const changedLocally =
        original.managed !== local.managed ||
        original.enforcementMode !== local.enforcementMode;
      return [resource, changedLocally ? local : params.latest[resource]];
    }),
  ) as ManagedResourcePolicyMap;
};
