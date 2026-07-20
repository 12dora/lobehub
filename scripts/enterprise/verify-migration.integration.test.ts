// @vitest-environment node
/**
 * Optional full-chain integration: random owned Postgres container, synthetic
 * 2.2.10 fixture, complete migration apply, official migrator rerun, cleanup.
 *
 * Enabled when MIGRATION_COMPAT_INTEGRATION=1 (requires Docker).
 * Never uses shared phase0 databases.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildSyntheticFixtureStatements } from './verify-migration/fixture';
import {
  createMigrationCompatReport,
  gatePassed,
  loadOfficialMigrations,
  migrationCompatReportSchema,
  runMigrationCompatVerification,
  scanForForbiddenReportContent,
  verifyIdentitySecretConstraintsPresent,
  verifySecretReferenceProbes,
} from './verify-migration/index';
import {
  applyOfficialBaselineMigrations,
  applyOfficialPostBaselineMigrations,
  countAppliedMigrations,
  snapshotMigrationJournal,
  verifyOfficialMigratorRerun,
} from './verify-migration/migrations';
import { createOwnedPostgres } from './verify-migration/ownedPostgres';
import { seedPlatformProbes } from './verify-migration/probes';

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
  it('applies 2.2.10 synthetic fixture through current migrations with official rerun', async () => {
    const { report } = await runMigrationCompatVerification({
      officialRerun: true,
      repoRoot,
    });

    const parsed = migrationCompatReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
    expect(scanForForbiddenReportContent(report).result).toBe('passed');
    expect(report.baseline.match).toBe('passed');
    expect(report.cleanupResult).toBe('passed');
    expect(report.syntheticResult).toBe('passed');
    expect(report.rerun.result).toBe('passed');
    expect(gatePassed(report)).toBe(true);
    expect(report.externalDump.status).toBe('absent');
    expect(report.overall).toBe('unverified');
    expect(report.ownedResource.kind).toBe('container-database');
    expect(report.ownedResource.resourceId).toMatch(/^m15q03_[a-f0-9]{16}$/);
    expect(report.checks).toHaveLength(14);

    const byCategory = Object.fromEntries(
      report.checks.map((check) => [check.category, check.result]),
    );
    expect(byCategory['apply-baseline']).toBe('passed');
    expect(byCategory['apply-post-baseline']).toBe('passed');
    expect(byCategory.revision).toBe('passed');
    expect(byCategory.audit).toBe('passed');
    expect(byCategory['secret-reference']).toBe('passed');
    expect(byCategory.rerun).toBe('passed');

    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(serialized).not.toMatch(/password|connectionString|DATABASE_URL/i);
    expect(serialized).not.toMatch(/127\.0\.0\.1/);

    const { redactionScan: _redactionScan, ...core } = report;
    expect(() => createMigrationCompatReport(core)).not.toThrow();
  }, 600_000);

  it('rejects secret-ref probes when production constraints are dropped (owned DB only)', async () => {
    const official = loadOfficialMigrations(repoRoot);
    const owned = await createOwnedPostgres();
    try {
      await owned.handle.withClient(async (client) => {
        await applyOfficialBaselineMigrations(client, repoRoot);
        for (const statement of buildSyntheticFixtureStatements()) {
          await client.query(statement);
        }
        await applyOfficialPostBaselineMigrations(client, repoRoot);
        expect(await countAppliedMigrations(client)).toBe(official.length);
        await seedPlatformProbes(client);

        expect(await verifyIdentitySecretConstraintsPresent(client)).toBe(true);
        const healthy = await verifySecretReferenceProbes(client);
        expect(healthy.match).toBe(true);
        expect(healthy.rowCount).toBeGreaterThanOrEqual(1);

        // Destructive: drop a production CHECK that secret_state relies on.
        await client.query(
          `ALTER TABLE platform_identity_providers
             DROP CONSTRAINT IF EXISTS platform_identity_providers_secret_state_check`,
        );
        expect(await verifyIdentitySecretConstraintsPresent(client)).toBe(false);
        const afterDrop = await verifySecretReferenceProbes(client);
        expect(afterDrop.match).toBe(false);
      });
    } finally {
      expect(await owned.cleanup()).toBe('passed');
    }
  }, 600_000);

  it('official migrator rerun leaves journal count and content unchanged at 136', async () => {
    const official = loadOfficialMigrations(repoRoot);
    expect(official.length).toBe(136);
    const owned = await createOwnedPostgres();
    try {
      await owned.handle.withPool(async (pool, client) => {
        await applyOfficialBaselineMigrations(client, repoRoot);
        for (const statement of buildSyntheticFixtureStatements()) {
          await client.query(statement);
        }
        await applyOfficialPostBaselineMigrations(client, repoRoot);
        await seedPlatformProbes(client);
        const before = await snapshotMigrationJournal(client);
        expect(before.count).toBe(136);
        const rerun = await verifyOfficialMigratorRerun(pool, repoRoot);
        expect(rerun.match).toBe(true);
        expect(rerun.beforeCount).toBe(136);
        expect(rerun.afterCount).toBe(136);
      });
    } finally {
      expect(await owned.cleanup()).toBe('passed');
    }
  }, 600_000);
});
