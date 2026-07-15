/**
 * Enterprise Feature Flag keys (env-driven).
 * All flags default to OFF — enabling is controlled by M15 rollout.
 *
 * `ENABLE_ENTERPRISE_ADMIN` is an M00 alias of `ENABLE_PLATFORM_ADMIN`.
 * Prefer `ENABLE_PLATFORM_ADMIN` in new code; both are accepted at parse time.
 */
export const ENTERPRISE_FEATURE_FLAG_KEYS = [
  'ENABLE_PLATFORM_ADMIN',
  'ENABLE_ENTERPRISE_ADMIN',
  'ENABLE_PLATFORM_MANAGED_AI',
  'ENABLE_PLATFORM_MANAGED_SKILLS',
  'ENABLE_PLATFORM_MANAGED_CONNECTORS',
  'ENABLE_PLATFORM_MANAGED_AGENTS',
  'ENABLE_PLATFORM_SETTINGS_POLICY',
  'ENABLE_RUNTIME_BRANDING',
  'ENABLE_DATABASE_OIDC',
] as const;

export type EnterpriseFeatureFlagKey = (typeof ENTERPRISE_FEATURE_FLAG_KEYS)[number];

/**
 * Canonical flag state used by server and clients.
 * Alias key `ENABLE_ENTERPRISE_ADMIN` is folded into `ENABLE_PLATFORM_ADMIN`.
 */
export interface EnterpriseFeatureFlags {
  ENABLE_DATABASE_OIDC: boolean;
  ENABLE_PLATFORM_ADMIN: boolean;
  ENABLE_PLATFORM_MANAGED_AGENTS: boolean;
  ENABLE_PLATFORM_MANAGED_AI: boolean;
  ENABLE_PLATFORM_MANAGED_CONNECTORS: boolean;
  ENABLE_PLATFORM_MANAGED_SKILLS: boolean;
  ENABLE_PLATFORM_SETTINGS_POLICY: boolean;
  ENABLE_RUNTIME_BRANDING: boolean;
}

/** All enterprise capabilities are closed by default. */
export const DEFAULT_ENTERPRISE_FEATURE_FLAGS: Readonly<EnterpriseFeatureFlags> = {
  ENABLE_PLATFORM_ADMIN: false,
  ENABLE_PLATFORM_MANAGED_AI: false,
  ENABLE_PLATFORM_MANAGED_SKILLS: false,
  ENABLE_PLATFORM_MANAGED_CONNECTORS: false,
  ENABLE_PLATFORM_MANAGED_AGENTS: false,
  ENABLE_PLATFORM_SETTINGS_POLICY: false,
  ENABLE_RUNTIME_BRANDING: false,
  ENABLE_DATABASE_OIDC: false,
};

/** Truthy env values accepted for boolean enterprise flags. */
export const ENTERPRISE_FLAG_TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export const isEnterpriseFlagTruthy = (raw: string | undefined | null): boolean => {
  if (raw == null) return false;
  return ENTERPRISE_FLAG_TRUTHY.has(raw.trim().toLowerCase());
};
