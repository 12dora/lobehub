import {
  MANAGED_RESOURCE_KINDS,
  type ManagedResourceKind,
} from '@/const/platform/managedResources';
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
    if (before.managed === after.managed && before.enforcementMode === after.enforcementMode) {
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
  if (!params.dirty && params.hasChanges && params.publishReady && params.canPublish) {
    return 'publish';
  }
  return 'none';
};

export type ManagedResourcePolicyField = 'enforcementMode' | 'managed';

export interface ManagedResourceRebaseConflict {
  field: ManagedResourcePolicyField;
  latestValue: ManagedResourcePolicyMap[ManagedResourceKind][ManagedResourcePolicyField];
  localValue: ManagedResourcePolicyMap[ManagedResourceKind][ManagedResourcePolicyField];
  originalValue: ManagedResourcePolicyMap[ManagedResourceKind][ManagedResourcePolicyField];
  resource: ManagedResourceKind;
}

export interface ManagedResourceRebaseResult {
  conflicts: ManagedResourceRebaseConflict[];
  draft: ManagedResourcePolicyMap;
}

const mergePolicyField = <Field extends ManagedResourcePolicyField>(params: {
  conflicts: ManagedResourceRebaseConflict[];
  field: Field;
  latest: ManagedResourcePolicyMap[ManagedResourceKind];
  local: ManagedResourcePolicyMap[ManagedResourceKind];
  original: ManagedResourcePolicyMap[ManagedResourceKind];
  resource: ManagedResourceKind;
}): ManagedResourcePolicyMap[ManagedResourceKind][Field] => {
  const originalValue = params.original[params.field];
  const localValue = params.local[params.field];
  const latestValue = params.latest[params.field];
  const localChanged = localValue !== originalValue;
  const latestChanged = latestValue !== originalValue;

  if (localChanged && latestChanged && localValue !== latestValue) {
    params.conflicts.push({
      field: params.field,
      latestValue,
      localValue,
      originalValue,
      resource: params.resource,
    });
  }

  return localChanged ? localValue : latestValue;
};

/** Field-level three-way merge. Divergent edits to one field remain explicit conflicts. */
export const rebaseManagedResourceDraft = (params: {
  latest: ManagedResourcePolicyMap;
  local: ManagedResourcePolicyMap;
  original: ManagedResourcePolicyMap;
}): ManagedResourceRebaseResult => {
  const conflicts: ManagedResourceRebaseConflict[] = [];
  const draft = Object.fromEntries(
    MANAGED_RESOURCE_KINDS.map((resource) => {
      const original = params.original[resource];
      const local = params.local[resource];
      const latest = params.latest[resource];
      return [
        resource,
        {
          enforcementMode: mergePolicyField({
            conflicts,
            field: 'enforcementMode',
            latest,
            local,
            original,
            resource,
          }),
          managed: mergePolicyField({
            conflicts,
            field: 'managed',
            latest,
            local,
            original,
            resource,
          }),
        },
      ];
    }),
  ) as ManagedResourcePolicyMap;

  return { conflicts, draft };
};
