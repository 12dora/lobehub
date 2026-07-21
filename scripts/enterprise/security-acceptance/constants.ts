/**
 * M13 PR-S05 enterprise security acceptance constants.
 * Repository automation only — never claims external production penetration testing.
 */

/** Fixed design baseline for enterprise redevelopment (LobeHub 2.2.10). */
export const BASELINE_COMMIT = '4bab1636408e60a7ee17b640490fbf33a310a325' as const;

export const SECURITY_ACCEPTANCE_LANE = 'enterprise-security-acceptance' as const;
export const SECURITY_ACCEPTANCE_SCHEMA_VERSION = 1 as const;

/** Explicit evidence class for all reports produced by this harness. */
export const EVIDENCE_CLASS = 'repository-automation' as const;

/** External human production pen-test is residual and never self-asserted here. */
export const EXTERNAL_PEN_TEST_STATUS = 'not-executed' as const;

export const REQUIRED_CHECK_IDS = ['dependency-scan', 'leakage-scan', 'pen-regression'] as const;

export type RequiredCheckId = (typeof REQUIRED_CHECK_IDS)[number];

/**
 * Check outcome vocabulary (fail-closed):
 * - passed: real execution succeeded under policy
 * - failed: real execution completed with policy violations or nonzero adapter result
 * - unavailable: tool/network/lockfile missing or scanner crashed before a trustworthy result
 * - not-executed: required adapter/target never ran (missing target, skipped, etc.)
 */
export const CHECK_STATUSES = ['passed', 'failed', 'unavailable', 'not-executed'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const OVERALL_STATUSES = ['passed', 'failed', 'unavailable'] as const;
export type OverallStatus = (typeof OVERALL_STATUSES)[number];

/** Fail dependency scan on these severities (explicit policy). */
export const DEPENDENCY_FAIL_SEVERITIES = ['high', 'critical'] as const;
export type DependencyFailSeverity = (typeof DEPENDENCY_FAIL_SEVERITIES)[number];

export const DEPENDENCY_SCANNER_ID = 'pnpm-audit' as const;
export const DEPENDENCY_SCANNER_ARGV = [
  'pnpm',
  'audit',
  '--prod',
  '--json',
  '--audit-level',
  'high',
] as const;

/** Bound subprocess capture to avoid OOM from pathological scanner output. */
export const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;

/** Max file size scanned for leakage (skip larger files as unavailable path). */
export const MAX_LEAKAGE_FILE_BYTES = 2 * 1024 * 1024;

/** Relative roots scanned for secret/log/trace/audit leakage (repo-owned surfaces). */
export const LEAKAGE_SCAN_ROOTS = [
  'apps/server/src/enterprise',
  'scripts/enterprise',
  'docs/security',
  'docs/enterprise',
  'packages/database/src/models/platform',
  '.github/workflows',
] as const;

/**
 * File extensions considered for leakage scanning.
 * Config/report surfaces included; binary extensions excluded by omission.
 */
export const LEAKAGE_SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.mdx',
  '.env',
  '.example',
  '.toml',
  '.txt',
]);
