/**
 * M15 Q06 production-readiness constants.
 * Shared by preflight, recovery drills, and operator runbooks.
 */

/** Fixed design baseline for enterprise redevelopment (LobeHub 2.2.10). */
export const BASELINE_COMMIT = '4bab1636408e60a7ee17b640490fbf33a310a325' as const;
export const BASELINE_VERSION = '2.2.10' as const;

export const PRODUCTION_READINESS_LANE = 'enterprise-production-readiness' as const;
export const PRODUCTION_READINESS_SCHEMA_VERSION = 1 as const;

export const BACKUP_RESTORE_LANE = 'enterprise-backup-restore-drill' as const;
export const BACKUP_RESTORE_SCHEMA_VERSION = 1 as const;

export const APP_ROLLBACK_LANE = 'enterprise-app-rollback-drill' as const;
export const APP_ROLLBACK_SCHEMA_VERSION = 1 as const;

/** Default max evidence age for production-authorized preflight (72h). */
export const DEFAULT_MAX_EVIDENCE_AGE_MS = 72 * 60 * 60 * 1000;
/** Accept clock skew between generators and preflight host. */
export const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Owned disposable Postgres identity for recovery harness (never phase0). */
export const OWNED_RESOURCE_PREFIX = 'm15q06' as const;
export const OWNED_CONTAINER_LABEL_TOKEN = 'com.lobehub.production-readiness-token' as const;
export const OWNED_CONTAINER_LABEL_EPHEMERAL =
  'com.lobehub.production-readiness-ephemeral' as const;
export const OWNED_POSTGRES_IMAGE = 'paradedb/paradedb:latest-pg17' as const;

/**
 * Evidence gate ids required for a complete production preflight.
 *
 * NOTE: `app-rollback` remains in the required set but is currently
 * **implementation-unavailable** (baseline ORM runtime cannot execute honestly).
 * The gate is fail-safe only: it never reports `passed`; production authorization
 * stays blocked until a real baseline install path is implemented.
 * See APP_ROLLBACK_IMPLEMENTATION_STATUS.
 */
export const REQUIRED_EVIDENCE_GATES = [
  'path-boundaries',
  'migration-compat',
  'enterprise-admin-e2e',
  'upstream-rebase',
  'failure-drills',
  'backup-restore',
  'app-rollback',
] as const;

export type EvidenceGateId = (typeof REQUIRED_EVIDENCE_GATES)[number];

/**
 * Explicit capability marker for the required app-rollback gate.
 * Not a silent stub: callers and tests must treat this as known-unavailable.
 */
export const APP_ROLLBACK_IMPLEMENTATION_STATUS = {
  gate: 'app-rollback' as const,
  reasonCode: 'baseline-orm-runtime-unavailable' as const,
  required: true,
  status: 'unavailable' as const,
} as const;

/** Milestone A–F release windows (stable ids). */
export const MILESTONE_WINDOW_IDS = [
  'milestone-a',
  'milestone-b',
  'milestone-c',
  'milestone-d',
  'milestone-e',
  'milestone-f',
] as const;

export type MilestoneWindowId = (typeof MILESTONE_WINDOW_IDS)[number];

/**
 * High-risk capabilities that must be first-enabled in separate windows.
 * Exactly one may appear as firstEnable per window (or 'none').
 */
export const HIGH_RISK_CAPABILITIES = [
  'none',
  'oidc',
  'connector-shared-credentials',
  'default-inbox',
  'branding-cutover',
] as const;

export type HighRiskCapability = (typeof HIGH_RISK_CAPABILITIES)[number];

export const FIRST_ENABLE_HIGH_RISK = [
  'oidc',
  'connector-shared-credentials',
  'default-inbox',
  'branding-cutover',
] as const;

/** Stable allowlisted command ids (no arbitrary shell). */
export const ALLOWLISTED_COMMAND_IDS = [
  'preflight-validate',
  'preflight-evaluate',
  'backup-restore-drill-local',
  'backup-restore-drill-production-authorized',
  'app-rollback-drill-local',
  'app-rollback-drill-production-authorized',
  'release-window-activate',
  'release-window-rollback',
  'release-window-verify-rollback',
  'flag-enable-oidc',
  'flag-disable-oidc',
  'flag-enable-connector-shared-credentials',
  'flag-disable-connector-shared-credentials',
  'flag-enable-default-inbox',
  'flag-disable-default-inbox',
  'flag-enable-branding-cutover',
  'flag-disable-branding-cutover',
  'monitor-release-window',
  'disaster-recovery-select-backup',
  'disaster-recovery-isolated-restore',
  'disaster-recovery-verify-invariants',
] as const;

export type AllowlistedCommandId = (typeof ALLOWLISTED_COMMAND_IDS)[number];

/** Core tables verified after restore (identity via digests only in evidence). */
export const RECOVERY_PROTECTED_TABLES = [
  'users',
  'sessions',
  'agents',
  'topics',
  'messages',
  'user_settings',
  'api_keys',
  'platform_resource_revisions',
  'platform_audit_logs',
  'platform_identity_providers',
  'platform_identity_provider_secrets',
  'platform_ai_providers',
  'platform_ai_provider_secrets',
  'platform_connectors',
  'platform_connector_secrets',
] as const;

export type RecoveryProtectedTable = (typeof RECOVERY_PROTECTED_TABLES)[number];

/** Preflight execution modes. */
export const PREFLIGHT_MODES = ['validate-harness', 'preflight', 'production-authorized'] as const;

export type PreflightMode = (typeof PREFLIGHT_MODES)[number];

export const EVIDENCE_SCOPES = ['local-harness', 'ci-harness', 'production-authorized'] as const;

export type EvidenceScope = (typeof EVIDENCE_SCOPES)[number];

export const CHECK_RESULTS = ['passed', 'failed', 'unverified', 'not-executed'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];
