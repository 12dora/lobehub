/**
 * Narrow, reviewed fixture allowlist for intentional synthetic secret samples.
 * Paths are relative to the repository root and matched exactly (posix).
 *
 * Adding a path requires human review — do not auto-discover allowlist entries.
 */
export const LEAKAGE_FIXTURE_ALLOWLIST = [
  // Harness self-fixtures (synthetic only).
  'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt',
  'scripts/enterprise/security-acceptance/fixtures/allowlist-boundary.fixture.txt',
  // Upstream-rebase secret family samples (synthetic regression strings).
  'scripts/enterprise/upstream-rebase-ci/secretScan.ts',
  'scripts/enterprise/upstream-rebase-ci/upstream-rebase-ci.test.ts',
  // Redaction detector regression suite (synthetic samples).
  'apps/server/src/enterprise/security/redaction/detectSecretMaterial.test.ts',
  // Platform redaction unit samples.
  'packages/database/src/models/platform/redact.ts',
] as const;

export type LeakageAllowlistPath = (typeof LEAKAGE_FIXTURE_ALLOWLIST)[number];

export const isLeakageAllowlisted = (relativePath: string): boolean =>
  (LEAKAGE_FIXTURE_ALLOWLIST as readonly string[]).includes(relativePath.replaceAll('\\', '/'));
