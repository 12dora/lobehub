/**
 * Stable enterprise business error codes.
 * UI maps codes — never free-text stack traces.
 *
 * Prefix rules (M00):
 * - PLATFORM_* — platform / revision / config / infra
 * - ADMIN_*    — admin console / reauth / reason gates
 * - MANAGED_*  — managed resource / setting enforcement
 * - RESOURCE_* — M06 canonical compatibility spelling for legacy mutation denial
 */

export const PLATFORM_ERROR_CODES = {
  PLATFORM_PERMISSION_DENIED: 'PLATFORM_PERMISSION_DENIED',
  PLATFORM_REVISION_CONFLICT: 'PLATFORM_REVISION_CONFLICT',
  PLATFORM_CONFIG_VALIDATION_FAILED: 'PLATFORM_CONFIG_VALIDATION_FAILED',
  PLATFORM_SECRET_REQUIRED: 'PLATFORM_SECRET_REQUIRED',
  PLATFORM_SECRET_NOT_READABLE: 'PLATFORM_SECRET_NOT_READABLE',
  PLATFORM_AI_MODEL_NOT_PUBLISHED: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
  PLATFORM_AI_MODEL_PULL_DISABLED: 'PLATFORM_AI_MODEL_PULL_DISABLED',
  PLATFORM_RESOURCE_IN_USE: 'PLATFORM_RESOURCE_IN_USE',
  PLATFORM_DEFAULT_AGENT_REQUIRED: 'PLATFORM_DEFAULT_AGENT_REQUIRED',
  PLATFORM_ACTIVATION_RESTART_REQUIRED: 'PLATFORM_ACTIVATION_RESTART_REQUIRED',
  PLATFORM_ROLLOUT_PARTIAL_FAILURE: 'PLATFORM_ROLLOUT_PARTIAL_FAILURE',
  PLATFORM_OIDC_DISCOVERY_FAILED: 'PLATFORM_OIDC_DISCOVERY_FAILED',
  PLATFORM_OIDC_CLAIM_VALIDATION_FAILED: 'PLATFORM_OIDC_CLAIM_VALIDATION_FAILED',
  PLATFORM_SSRF_BLOCKED: 'PLATFORM_SSRF_BLOCKED',
  PLATFORM_FEATURE_DISABLED: 'PLATFORM_FEATURE_DISABLED',
  PLATFORM_LAST_SUPER_ADMIN: 'PLATFORM_LAST_SUPER_ADMIN',
  PLATFORM_NOT_FOUND: 'PLATFORM_NOT_FOUND',
  PLATFORM_INVALID_INPUT: 'PLATFORM_INVALID_INPUT',
  /**
   * User is authenticated but lacks EasyAuth base access (`aihub.access`).
   * Contract alias used in docs/list: ACCESS_NOT_GRANTED → this code (PLATFORM_ prefix rule).
   */
  PLATFORM_ACCESS_NOT_GRANTED: 'PLATFORM_ACCESS_NOT_GRANTED',
} as const;

/**
 * Stable alias matching the M02 / tRPC interface list name `ACCESS_NOT_GRANTED`.
 * Prefer `PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED` in new server code.
 */
export const ACCESS_NOT_GRANTED = PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED;

export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[keyof typeof PLATFORM_ERROR_CODES];

export const ADMIN_ERROR_CODES = {
  ADMIN_ACCESS_DENIED: 'ADMIN_ACCESS_DENIED',
  ADMIN_REAUTH_REQUIRED: 'ADMIN_REAUTH_REQUIRED',
  ADMIN_REASON_REQUIRED: 'ADMIN_REASON_REQUIRED',
  ADMIN_FEATURE_DISABLED: 'ADMIN_FEATURE_DISABLED',
} as const;

export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[keyof typeof ADMIN_ERROR_CODES];

export const MANAGED_ERROR_CODES = {
  /** M06 canonical legacy-mutation denial returned by ManagedResourceGuard. */
  RESOURCE_MANAGED_BY_PLATFORM: 'RESOURCE_MANAGED_BY_PLATFORM',
  MANAGED_RESOURCE_BY_PLATFORM: 'MANAGED_RESOURCE_BY_PLATFORM',
  MANAGED_SETTING_BY_ADMIN: 'MANAGED_SETTING_BY_ADMIN',
  MANAGED_POLICY_ENFORCED: 'MANAGED_POLICY_ENFORCED',
  /** Path is not in the finite settings registry. */
  MANAGED_SETTING_UNKNOWN_PATH: 'MANAGED_SETTING_UNKNOWN_PATH',
  /** Path is secret / sensitive and never policy-eligible. */
  MANAGED_SETTING_SECRET_PATH: 'MANAGED_SETTING_SECRET_PATH',
  /** Path is not applicable to the requested client surface. */
  MANAGED_SETTING_INAPPLICABLE_CLIENT: 'MANAGED_SETTING_INAPPLICABLE_CLIENT',
  /** Path is registered but not platform-policy eligible. */
  MANAGED_SETTING_NOT_POLICY_ELIGIBLE: 'MANAGED_SETTING_NOT_POLICY_ELIGIBLE',
  /** Value failed the registry Zod schema. */
  MANAGED_SETTING_INVALID_VALUE: 'MANAGED_SETTING_INVALID_VALUE',
} as const;

export type ManagedErrorCode = (typeof MANAGED_ERROR_CODES)[keyof typeof MANAGED_ERROR_CODES];

export const ENTERPRISE_ERROR_CODES = {
  ...PLATFORM_ERROR_CODES,
  ...ADMIN_ERROR_CODES,
  ...MANAGED_ERROR_CODES,
} as const;

export type EnterpriseErrorCode = PlatformErrorCode | AdminErrorCode | ManagedErrorCode;

const ALL_CODE_VALUES = new Set<string>(Object.values(ENTERPRISE_ERROR_CODES));

export const isEnterpriseErrorCode = (value: string): value is EnterpriseErrorCode =>
  ALL_CODE_VALUES.has(value);

/** Required prefixes for every enterprise business error code. */
export const ENTERPRISE_ERROR_CODE_PREFIXES = [
  'PLATFORM_',
  'ADMIN_',
  'MANAGED_',
  // M06 public contract spelling retained for legacy-router compatibility.
  'RESOURCE_',
] as const;

export const hasEnterpriseErrorPrefix = (code: string): boolean =>
  ENTERPRISE_ERROR_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
