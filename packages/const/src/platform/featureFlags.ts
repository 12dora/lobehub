/**
 * Enterprise Feature Flag keys (env-driven).
 *
 * LobeHub Enhanced ships every enhancement **enabled by default**: an unset flag
 * resolves to ON. Set a flag to an explicit falsy value (`0` / `false` / `no` /
 * `off`, case-insensitive) to turn that feature off.
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

/**
 * Every enterprise capability is open by default — this is what an unconfigured
 * deployment gets. Access is still gated by platform RBAC: turning a feature on
 * only mounts its surface, it never grants anyone permissions.
 */
export const DEFAULT_ENTERPRISE_FEATURE_FLAGS: Readonly<EnterpriseFeatureFlags> = {
  ENABLE_PLATFORM_ADMIN: true,
  ENABLE_PLATFORM_MANAGED_AI: true,
  ENABLE_PLATFORM_MANAGED_SKILLS: true,
  ENABLE_PLATFORM_MANAGED_CONNECTORS: true,
  ENABLE_PLATFORM_MANAGED_AGENTS: true,
  ENABLE_PLATFORM_SETTINGS_POLICY: true,
  ENABLE_RUNTIME_BRANDING: true,
  ENABLE_DATABASE_OIDC: true,
};

/**
 * Every enterprise capability closed. Not a deployment default — used by callers
 * and tests that need an explicit "upstream parity" baseline.
 */
export const DISABLED_ENTERPRISE_FEATURE_FLAGS: Readonly<EnterpriseFeatureFlags> = {
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

/** Falsy env values that explicitly disable an otherwise default-on flag. */
export const ENTERPRISE_FLAG_FALSY = new Set(['0', 'false', 'no', 'off']);

const normalize = (raw: string | undefined | null): string | null => {
  if (raw == null) return null;
  const value = raw.trim().toLowerCase();
  return value.length > 0 ? value : null;
};

/** True only for an explicit truthy value. Unset / blank / anything else → false. */
export const isEnterpriseFlagTruthy = (raw: string | undefined | null): boolean => {
  const value = normalize(raw);
  return value !== null && ENTERPRISE_FLAG_TRUTHY.has(value);
};

/** True only for an explicit falsy value. Unset / blank / anything else → false. */
export const isEnterpriseFlagFalsy = (raw: string | undefined | null): boolean => {
  const value = normalize(raw);
  return value !== null && ENTERPRISE_FLAG_FALSY.has(value);
};

/**
 * Resolve one default-on enterprise flag: only an explicit falsy value disables it.
 * Unset, blank, or an unrecognised value keeps the feature enabled.
 */
export const isEnterpriseFlagEnabled = (raw: string | undefined | null): boolean =>
  !isEnterpriseFlagFalsy(raw);

/**
 * Resolve the platform-admin master switch from its canonical key and the
 * `ENABLE_ENTERPRISE_ADMIN` alias. An explicit truthy value on either key wins over
 * an explicit falsy value on the other; otherwise a falsy value disables it, and an
 * unconfigured environment leaves it enabled.
 *
 * Shared so the tRPC context, the database access resolver and the server-side flag
 * parser can never drift apart.
 */
export const isPlatformAdminFlagEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const keys = [env.ENABLE_PLATFORM_ADMIN, env.ENABLE_ENTERPRISE_ADMIN];
  if (keys.some((value) => isEnterpriseFlagTruthy(value))) return true;
  return !keys.some((value) => isEnterpriseFlagFalsy(value));
};
