import {
  DEFAULT_ENTERPRISE_FEATURE_FLAGS,
  type EnterpriseFeatureFlags,
  isEnterpriseFlagTruthy,
} from '@/const/platform/featureFlags';

export type EnterpriseFeatureFlagEnv = Partial<
  Record<keyof EnterpriseFeatureFlags | 'ENABLE_ENTERPRISE_ADMIN', string | undefined>
>;

/**
 * Parse enterprise feature flags from environment (or injected map).
 * All flags default OFF. `ENABLE_ENTERPRISE_ADMIN` is an alias of `ENABLE_PLATFORM_ADMIN`.
 */
export const parseEnterpriseFeatureFlags = (
  env: EnterpriseFeatureFlagEnv = process.env,
): EnterpriseFeatureFlags => {
  const platformAdmin =
    isEnterpriseFlagTruthy(env.ENABLE_PLATFORM_ADMIN) ||
    isEnterpriseFlagTruthy(env.ENABLE_ENTERPRISE_ADMIN);

  return {
    ENABLE_DATABASE_OIDC: isEnterpriseFlagTruthy(env.ENABLE_DATABASE_OIDC),
    ENABLE_PLATFORM_ADMIN: platformAdmin,
    ENABLE_PLATFORM_MANAGED_AGENTS: isEnterpriseFlagTruthy(env.ENABLE_PLATFORM_MANAGED_AGENTS),
    ENABLE_PLATFORM_MANAGED_AI: isEnterpriseFlagTruthy(env.ENABLE_PLATFORM_MANAGED_AI),
    ENABLE_PLATFORM_MANAGED_CONNECTORS: isEnterpriseFlagTruthy(
      env.ENABLE_PLATFORM_MANAGED_CONNECTORS,
    ),
    ENABLE_PLATFORM_MANAGED_SKILLS: isEnterpriseFlagTruthy(env.ENABLE_PLATFORM_MANAGED_SKILLS),
    ENABLE_PLATFORM_SETTINGS_POLICY: isEnterpriseFlagTruthy(env.ENABLE_PLATFORM_SETTINGS_POLICY),
    ENABLE_RUNTIME_BRANDING: isEnterpriseFlagTruthy(env.ENABLE_RUNTIME_BRANDING),
  };
};

export const getEnterpriseFeatureFlags = (): EnterpriseFeatureFlags =>
  parseEnterpriseFeatureFlags(process.env);

export const isPlatformAdminFeatureEnabled = (
  flags: EnterpriseFeatureFlags = getEnterpriseFeatureFlags(),
): boolean => flags.ENABLE_PLATFORM_ADMIN;

/** Snapshot of defaults for regression tests (flags closed). */
export const getDefaultEnterpriseFeatureFlags = (): EnterpriseFeatureFlags => ({
  ...DEFAULT_ENTERPRISE_FEATURE_FLAGS,
});
