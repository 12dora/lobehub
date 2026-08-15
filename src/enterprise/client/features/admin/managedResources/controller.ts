import {
  MANAGED_RESOURCE_KINDS,
  type ManagedResourceKind,
} from '@/const/platform/managedResources';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type {
  ManagedResourcePolicyItem,
  ManagedResourcePolicyMap,
  ManagedResourceReadinessMap,
} from '@/types/platform/managedResources';

/**
 * Admin UI collapses the legacy (managed × enforcementMode) matrix into two modes:
 * - user: users configure themselves; platform presets are not forced (managed false + observe)
 * - platform: hide user settings entry and enforce admin presets (managed true + enforced)
 */
export type ManagedResourceUiMode = 'platform' | 'user';

/** Map each managed resource card label to the matching admin side-nav i18n key. */
export const MANAGED_RESOURCE_NAV_LABEL_KEY = {
  agents: 'nav.agents',
  aiModels: 'nav.aiServiceModel',
  aiProviders: 'nav.aiProviders',
  connectors: 'nav.aiConnectors',
  skills: 'nav.aiSkills',
} as const satisfies Record<ManagedResourceKind, string>;

/**
 * Read historical policies into the two-state UI.
 * true+ui-only and true+enforced → platform; true+observe / unmanaged → user.
 */
export const toManagedResourceUiMode = (item: ManagedResourcePolicyItem): ManagedResourceUiMode => {
  if (item.managed && (item.enforcementMode === 'enforced' || item.enforcementMode === 'ui-only')) {
    return 'platform';
  }
  return 'user';
};

/** Canonical write form for the two-state UI (also used to normalize on save). */
export const fromManagedResourceUiMode = (
  mode: ManagedResourceUiMode,
): ManagedResourcePolicyItem =>
  mode === 'platform'
    ? { enforcementMode: 'enforced', managed: true }
    : { enforcementMode: 'observe', managed: false };

export const normalizeManagedResourcePolicyMap = (
  policy: ManagedResourcePolicyMap,
): ManagedResourcePolicyMap =>
  Object.fromEntries(
    MANAGED_RESOURCE_KINDS.map((resource) => [
      resource,
      fromManagedResourceUiMode(toManagedResourceUiMode(policy[resource])),
    ]),
  ) as ManagedResourcePolicyMap;

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

/**
 * After a successful save, keep the in-memory draft when the local edit epoch advanced
 * during the request (concurrent edits). Callers must not apply the submitted snapshot
 * when this returns true — those newer edits are still unsaved.
 */
export const shouldPreserveLocalDraftAfterSave = (
  submittedEpoch: number,
  currentEpoch: number,
): boolean => currentEpoch !== submittedEpoch;
