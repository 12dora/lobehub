// @vitest-environment node
/**
 * Optional full-chain integration: random owned Postgres container, synthetic
 * 2.2.10 fixture, complete migration apply, invariants, cleanup.
 *
 * Enabled when MIGRATION_COMPAT_INTEGRATION=1 (requires Docker).
 * Never uses shared phase0 databases.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createMigrationCompatReport,
  isPassingSyntheticReport,
  migrationCompatReportSchema,
  runMigrationCompatVerification,
  scanForForbiddenReportContent,
} from './verify-migration/index';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const dockerAvailable = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const enabled = process.env.MIGRATION_COMPAT_INTEGRATION === '1' && dockerAvailable;

describe.skipIf(!enabled)('migration compat integration (owned disposable Postgres)', () => {
  it('applies 2.2.10 synthetic fixture through current migrations with secret-free report', async () => {
    const { report } = await runMigrationCompatVerification({
      idempotentRerun: true,
      repoRoot,
    });

    const parsed = migrationCompatReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
    expect(scanForForbiddenReportContent(report).result).toBe('passed');
    expect(report.baseline.match).toBe('passed');
    expect(report.cleanupResult).toBe('passed');
    expect(report.syntheticResult).toBe('passed');
    expect(isPassingSyntheticReport(report)).toBe(true);
    // Missing real production dump must remain unverified, never pass overall.
    expect(report.externalDump.status).toBe('absent');
    expect(report.overall).toBe('unverified');
    expect(report.ownedResource.kind).toBe('container-database');
    expect(report.ownedResource.resourceId).toMatch(/^m15q03_[a-f0-9]{16}$/);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(serialized).not.toMatch(/password|connectionString|DATABASE_URL/i);
    expect(serialized).not.toMatch(/127\.0\.0\.1/);

    // Core fields remain acceptable to the secret-free schema factory.
    const { redactionScan: _redactionScan, ...core } = report;
    expect(() => createMigrationCompatReport(core)).not.toThrow();
  }, 600_000);
});
