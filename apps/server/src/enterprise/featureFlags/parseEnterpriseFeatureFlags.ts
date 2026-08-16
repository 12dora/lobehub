import {
  DEFAULT_ENTERPRISE_FEATURE_FLAGS,
  type EnterpriseFeatureFlags,
  isEnterpriseFlagEnabled,
  isPlatformAdminFlagEnabled,
} from '@/const/platform/featureFlags';

/**
 * Env bag for enterprise flags.
 * Accepts `process.env` (ProcessEnv) and plain maps in tests.
 * Known keys: ENABLE_PLATFORM_ADMIN, ENABLE_ENTERPRISE_ADMIN (alias),
 * ENABLE_PLATFORM_MANAGED_*, ENABLE_PLATFORM_SETTINGS_POLICY,
 * ENABLE_RUNTIME_BRANDING, ENABLE_DATABASE_OIDC.
 */
export type EnterpriseFeatureFlagEnv = Record<string, string | undefined>;

/**
 * Parse enterprise feature flags from environment (or injected map).
 *
 * Every flag defaults **ON**: an unset (or unrecognised) value keeps the feature
 * enabled, and only an explicit `0` / `false` / `no` / `off` disables it.
 * `ENABLE_ENTERPRISE_ADMIN` is an alias of `ENABLE_PLATFORM_ADMIN`.
 */
export const parseEnterpriseFeatureFlags = (
  env: EnterpriseFeatureFlagEnv = process.env,
): EnterpriseFeatureFlags => ({
  ENABLE_DATABASE_OIDC: isEnterpriseFlagEnabled(env.ENABLE_DATABASE_OIDC),
  ENABLE_PLATFORM_ADMIN: isPlatformAdminFlagEnabled(env),
  ENABLE_PLATFORM_MANAGED_AGENTS: isEnterpriseFlagEnabled(env.ENABLE_PLATFORM_MANAGED_AGENTS),
  ENABLE_PLATFORM_MANAGED_AI: isEnterpriseFlagEnabled(env.ENABLE_PLATFORM_MANAGED_AI),
  ENABLE_PLATFORM_MANAGED_CONNECTORS: isEnterpriseFlagEnabled(
    env.ENABLE_PLATFORM_MANAGED_CONNECTORS,
  ),
  ENABLE_PLATFORM_MANAGED_SKILLS: isEnterpriseFlagEnabled(env.ENABLE_PLATFORM_MANAGED_SKILLS),
  ENABLE_PLATFORM_SETTINGS_POLICY: isEnterpriseFlagEnabled(env.ENABLE_PLATFORM_SETTINGS_POLICY),
  ENABLE_RUNTIME_BRANDING: isEnterpriseFlagEnabled(env.ENABLE_RUNTIME_BRANDING),
});

export const getEnterpriseFeatureFlags = (): EnterpriseFeatureFlags =>
  parseEnterpriseFeatureFlags(process.env);

export const isPlatformAdminFeatureEnabled = (
  flags: EnterpriseFeatureFlags = getEnterpriseFeatureFlags(),
): boolean => flags.ENABLE_PLATFORM_ADMIN;

/** True when any enterprise flag is on — gates client platform.* fetches. */
export const isAnyEnterpriseFeatureEnabled = (
  flags: EnterpriseFeatureFlags = getEnterpriseFeatureFlags(),
): boolean => Object.values(flags).some(Boolean);

/** Snapshot of the shipped defaults (every enterprise feature open). */
export const getDefaultEnterpriseFeatureFlags = (): EnterpriseFeatureFlags => ({
  ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
});
