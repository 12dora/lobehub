import type {
  ManagedResourceEnforcementMode,
  ManagedResourceKind,
} from '@/const/platform/managedResources';

export interface ManagedResourcePolicyItem {
  enforcementMode: ManagedResourceEnforcementMode;
  managed: boolean;
}

export type ManagedResourcePolicyMap = Record<ManagedResourceKind, ManagedResourcePolicyItem>;
export type ManagedResourceReadinessMap = Record<ManagedResourceKind, boolean>;

/** JSONB contract persisted per resource row; draft is never read by runtime guards. */
export interface PlatformManagedResourcePolicyConfig {
  draft: ManagedResourcePolicyItem;
  published: ManagedResourcePolicyItem;
}

export const MANAGED_POLICY_RESOURCE_ID = 'global' as const;
export const MANAGED_POLICY_RESOURCE_TYPE = 'managed_policy' as const;
