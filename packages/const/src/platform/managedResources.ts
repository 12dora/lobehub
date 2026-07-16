/**
 * Platform-managed resource kinds (public boolean surface only).
 * Enforcement modes and policy payloads live in later modules (M06+).
 */
export const MANAGED_RESOURCE_KINDS = [
  'aiProviders',
  'aiModels',
  'skills',
  'connectors',
  'agents',
] as const;

export type ManagedResourceKind = (typeof MANAGED_RESOURCE_KINDS)[number];

/** Progressive rollout modes. Only `enforced` is a server-side deny mode. */
export const MANAGED_RESOURCE_ENFORCEMENT_MODES = ['observe', 'ui-only', 'enforced'] as const;

export type ManagedResourceEnforcementMode = (typeof MANAGED_RESOURCE_ENFORCEMENT_MODES)[number];

/** Default: nothing is platform-managed until corresponding flags + policies enable it. */
export const DEFAULT_MANAGED_RESOURCES: Readonly<Record<ManagedResourceKind, boolean>> = {
  aiProviders: false,
  aiModels: false,
  skills: false,
  connectors: false,
  agents: false,
};
