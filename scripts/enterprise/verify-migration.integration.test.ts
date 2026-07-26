// @vitest-environment node
/**
 * Docker-backed compatibility lane:
 *  - materializes and migrates the pinned v2.2.10 chain, then upgrades it
 *    through the active squashed-chain follow-ups;
 *  - applies the active chain to a fresh database;
 *  - exercises the production secret-reference constraints.
 *
 * Enabled by ENTERPRISE_MIGRATION_COMPAT_INTEGRATION=1 or the legacy
 * MIGRATION_COMPAT_INTEGRATION=1 alias. CI rejects skipped results.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { materializeHistoricalBaselineFixture } from './verify-migration/baseline';
import {
  buildSyntheticFixtureStatements,
  createMigrationCompatReport,
  gatePassed,
  loadOfficialMigrations,
  migrationCompatReportSchema,
  runMigrationCompatVerification,
  scanForForbiddenReportContent,
} from './verify-migration/index';
import {
  verifyAuditInfrastructure,
  verifyRevisionInfrastructure,
  verifySecretReferenceInvariants,
} from './verify-migration/invariants';
import {
  countAppliedMigrations,
  runOfficialNodePostgresMigrator,
  runOfficialNodePostgresMigratorFromFolder,
  verifyOfficialMigratorRerun,
} from './verify-migration/migrations';
import { createOwnedPostgres } from './verify-migration/ownedPostgres';
import {
  seedPlatformProbes,
  verifyIdentitySecretConstraintsPresent,
} from './verify-migration/probes';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const dockerAvailable = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const enabled =
  (process.env.ENTERPRISE_MIGRATION_COMPAT_INTEGRATION === '1' ||
    process.env.MIGRATION_COMPAT_INTEGRATION === '1') &&
  dockerAvailable;

interface CatalogSnapshot {
  attributes: Record<string, unknown>[];
  constraints: Record<string, unknown>[];
  indexes: Record<string, unknown>[];
  triggers: Record<string, unknown>[];
}

const snapshotPublicCatalog = async (
  client: Parameters<
    Parameters<Awaited<ReturnType<typeof createOwnedPostgres>>['handle']['withClient']>[0]
  >[0],
): Promise<CatalogSnapshot> => {
  const attributes = await client.query<Record<string, unknown>>(
    `SELECT c.relname AS table_name,
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS default_expression
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d
         ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attname`,
  );
  const constraints = await client.query<Record<string, unknown>>(
    `SELECT c.relname AS table_name,
            con.conname AS constraint_name,
            con.contype AS constraint_type,
            pg_get_constraintdef(con.oid, true) AS definition,
            con.convalidated AS validated
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
      ORDER BY c.relname, con.conname`,
  );
  const indexes = await client.query<Record<string, unknown>>(
    `SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
       FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname`,
  );
  const triggers = await client.query<Record<string, unknown>>(
    `SELECT c.relname AS table_name,
            t.tgname AS trigger_name,
            pg_get_triggerdef(t.oid, true) AS definition,
            t.tgenabled AS enabled
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND NOT t.tgisinternal
      ORDER BY c.relname, t.tgname`,
  );

  return {
    attributes: attributes.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
  };
};

describe.skipIf(!enabled)('migration compatibility (owned disposable Postgres)', () => {
  it('upgrades a pinned v2.2.10 database through the active follow-ups', async () => {
    const { report } = await runMigrationCompatVerification({
      officialRerun: true,
      repoRoot,
    });

    expect(migrationCompatReportSchema.safeParse(report).success).toBe(true);
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

  it('applies the active squashed chain to a fresh database and reruns idempotently', async () => {
    const official = loadOfficialMigrations(repoRoot);
    expect(official.map(({ tag }) => tag)).toEqual([
      '0000_squash_baseline',
      '0001_upgrade_from_2_2_10',
      '0002_r4_w1_evidence',
      '0011_r4_w2_db',
    ]);

    const owned = await createOwnedPostgres();
    try {
      await owned.handle.withPool(async (pool, client) => {
        await runOfficialNodePostgresMigrator(pool, repoRoot);
        expect(await countAppliedMigrations(client)).toBe(official.length);

        const tables = await client.query<{ table_name: string }>(
          `SELECT table_name
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('users', 'messages', 'platform_audit_exports')`,
        );
        expect(new Set(tables.rows.map(({ table_name }) => table_name))).toEqual(
          new Set(['messages', 'platform_audit_exports', 'users']),
        );

        await seedPlatformProbes(client);
        expect((await verifyRevisionInfrastructure(client)).match).toBe(true);
        expect((await verifyAuditInfrastructure(client)).match).toBe(true);
        expect((await verifySecretReferenceInvariants(client)).match).toBe(true);

        const rerun = await verifyOfficialMigratorRerun(pool, repoRoot);
        expect(rerun).toMatchObject({
          afterCount: official.length,
          beforeCount: official.length,
          match: true,
        });
      });
    } finally {
      expect(await owned.cleanup()).toBe('passed');
    }
  }, 600_000);

  it('produces the same normalized PostgreSQL catalog for fresh and v2.2.10 upgrade paths', async () => {
    const fresh = await createOwnedPostgres();
    let freshCatalog: CatalogSnapshot;
    try {
      freshCatalog = await fresh.handle.withPool(async (pool, client) => {
        await runOfficialNodePostgresMigrator(pool, repoRoot);
        return snapshotPublicCatalog(client);
      });
    } finally {
      expect(await fresh.cleanup()).toBe('passed');
    }

    const historical = materializeHistoricalBaselineFixture(repoRoot);
    const upgraded = await createOwnedPostgres();
    try {
      const upgradedCatalog = await upgraded.handle.withPool(async (pool, client) => {
        await runOfficialNodePostgresMigratorFromFolder(pool, historical.migrationsFolder);
        for (const statement of buildSyntheticFixtureStatements()) {
          await client.query(statement);
        }
        await runOfficialNodePostgresMigrator(pool, repoRoot);
        return snapshotPublicCatalog(client);
      });

      expect(upgradedCatalog).toEqual(freshCatalog);
    } finally {
      historical.cleanup();
      expect(await upgraded.cleanup()).toBe('passed');
    }
  }, 600_000);

  it('rejects a missing fingerprint while retaining the valid secret reference', async () => {
    const owned = await createOwnedPostgres();
    try {
      await owned.handle.withPool(async (pool, client) => {
        await runOfficialNodePostgresMigrator(pool, repoRoot);
        await seedPlatformProbes(client);
        expect(await verifyIdentitySecretConstraintsPresent(client)).toBe(true);

        await expect(
          client.query(
            `UPDATE platform_identity_providers
                SET secret_fingerprint = NULL, secret_updated_at = now()
              WHERE id = $1`,
            ['pidp_m15q03_probe_01'],
          ),
        ).rejects.toThrow(/secret_state_check|check constraint/i);

        const row = await client.query<{
          secret_fingerprint: string | null;
          secret_ref: string | null;
        }>(
          `SELECT secret_ref, secret_fingerprint
             FROM platform_identity_providers
            WHERE id = $1`,
          ['pidp_m15q03_probe_01'],
        );
        expect(row.rows[0]?.secret_ref).toMatch(/^kms:\/\/platform-identity-providers\//);
        expect(row.rows[0]?.secret_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      });
    } finally {
      expect(await owned.cleanup()).toBe('passed');
    }
  }, 600_000);
});
