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
  applyOfficialMigrationRange,
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

  it('official migrator rerun leaves journal count and content unchanged at head count', async () => {
    const official = loadOfficialMigrations(repoRoot);
    expect(official.length).toBeGreaterThanOrEqual(137);
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
        expect(before.count).toBe(official.length);
        const rerun = await verifyOfficialMigratorRerun(pool, repoRoot);
        expect(rerun.match).toBe(true);
        expect(rerun.beforeCount).toBe(official.length);
        expect(rerun.afterCount).toBe(official.length);
      });
    } finally {
      expect(await owned.cleanup()).toBe('passed');
    }
  }, 600_000);

  it('rejects NULL secret_fingerprint when secret_ref is set (missing-fingerprint regression)', async () => {
    const owned = await createOwnedPostgres();
    try {
      await owned.handle.withClient(async (client) => {
        await applyOfficialBaselineMigrations(client, repoRoot);
        for (const statement of buildSyntheticFixtureStatements()) {
          await client.query(statement);
        }
        await applyOfficialPostBaselineMigrations(client, repoRoot);
        await seedPlatformProbes(client);

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
           FROM platform_identity_providers WHERE id = $1`,
          ['pidp_m15q03_probe_01'],
        );
        expect(row.rows[0]?.secret_ref).toMatch(/^kms:\/\/platform-identity-providers\//);
        expect(row.rows[0]?.secret_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      });
    } finally {
      expect(await owned.cleanup()).toBe('passed');
    }
  }, 600_000);

  it('quarantines 0135-legal invalid secret triples then applies 0136 and official rerun', async () => {
    const official = loadOfficialMigrations(repoRoot);
    expect(official.length).toBeGreaterThanOrEqual(137);
    // 0135 is idx 135; 0136 is idx 136.
    const through0135 = 135;
    const only0136 = 136;

    const owned = await createOwnedPostgres();
    try {
      await owned.handle.withPool(async (pool, client) => {
        await applyOfficialMigrationRange(client, repoRoot, 0, through0135);
        expect(await countAppliedMigrations(client)).toBe(through0135 + 1);

        // Under the pre-0136 CHECK, NULL ~ regex is UNKNOWN → accepted.
        // Seed multiple lifecycle statuses with the same invalid triple family.
        const invalidRows = [
          { id: 'pidp_m15q03_legacy_active', key: 'm15q03-legacy-active', status: 'active' },
          {
            id: 'pidp_m15q03_legacy_published',
            key: 'm15q03-legacy-published',
            status: 'published',
          },
          {
            id: 'pidp_m15q03_legacy_pending',
            key: 'm15q03-legacy-pending',
            status: 'pending_restart',
          },
          { id: 'pidp_m15q03_legacy_draft', key: 'm15q03-legacy-draft', status: 'draft' },
        ] as const;

        for (const row of invalidRows) {
          await client.query(
            `INSERT INTO platform_identity_providers
                (id, provider_key, type, display_name, button_label,
                 secret_ref, secret_fingerprint, secret_updated_at,
                 scopes, use_pkce, status, revision, enabled, migration_required,
                 activation_revision)
               VALUES
                ($1, $2, 'generic_oidc', $3, 'Legacy',
                 $4, NULL, now(),
                 '["openid","profile","email"]'::jsonb, true, $5, 1, true, false,
                 1)`,
            [
              row.id,
              row.key,
              `Legacy ${row.status}`,
              `kms://platform-identity-providers/${row.key}`,
              row.status,
            ],
          );
        }

        // Confirm 0135-state accepted the invalid triple (ref set, fingerprint NULL).
        const before = await client.query<{
          id: string;
          secret_fingerprint: string | null;
          secret_ref: string | null;
        }>(
          `SELECT id, secret_ref, secret_fingerprint
             FROM platform_identity_providers
             WHERE id LIKE 'pidp_m15q03_legacy_%'
             ORDER BY id`,
        );
        expect(before.rows).toHaveLength(4);
        for (const row of before.rows) {
          expect(row.secret_ref).toMatch(/^kms:\/\/platform-identity-providers\//);
          expect(row.secret_fingerprint).toBeNull();
        }

        // Apply only 0136: quarantine + strengthened CHECK.
        const applied = await applyOfficialMigrationRange(client, repoRoot, only0136, only0136);
        expect(applied.appliedCount).toBe(1);
        expect(await countAppliedMigrations(client)).toBe(official.length);

        const after = await client.query<{
          activation_revision: number | null;
          enabled: boolean;
          id: string;
          migration_required: boolean;
          secret_fingerprint: string | null;
          secret_ref: string | null;
          secret_updated_at: Date | null;
          status: string;
        }>(
          `SELECT id, secret_ref, secret_fingerprint, secret_updated_at,
                    enabled, activation_revision, migration_required, status
             FROM platform_identity_providers
             WHERE id LIKE 'pidp_m15q03_legacy_%'
             ORDER BY id`,
        );
        expect(after.rows).toHaveLength(4);
        for (const row of after.rows) {
          // Empty secret triple — never fabricated fingerprint / retained handle.
          expect(row.secret_ref).toBeNull();
          expect(row.secret_fingerprint).toBeNull();
          expect(row.secret_updated_at).toBeNull();
          expect(row.enabled).toBe(false);
          expect(row.activation_revision).toBeNull();
          expect(row.migration_required).toBe(true);
          // Active-ish statuses coerced to error; draft preserved.
          if (row.id.endsWith('_draft')) {
            expect(row.status).toBe('draft');
          } else {
            expect(row.status).toBe('error');
          }
        }

        // Strengthened CHECK rejects the exact missing-fingerprint mutation.
        await client.query(
          `UPDATE platform_identity_providers
             SET secret_ref = $1, secret_fingerprint = $2, secret_updated_at = now(),
                 migration_required = false
             WHERE id = $3`,
          [
            'kms://platform-identity-providers/m15q03-rebind',
            'a'.repeat(64),
            'pidp_m15q03_legacy_draft',
          ],
        );
        await expect(
          client.query(
            `UPDATE platform_identity_providers
               SET secret_fingerprint = NULL, secret_updated_at = now()
               WHERE id = $1`,
            ['pidp_m15q03_legacy_draft'],
          ),
        ).rejects.toThrow(/secret_state_check|check constraint/i);

        // Official migrator no-op; journal unchanged.
        const beforeJournal = await snapshotMigrationJournal(client);
        expect(beforeJournal.count).toBe(official.length);
        const rerun = await verifyOfficialMigratorRerun(pool, repoRoot);
        expect(rerun.match).toBe(true);
        expect(rerun.beforeCount).toBe(official.length);
        expect(rerun.afterCount).toBe(official.length);
      });
    } finally {
      expect(await owned.cleanup()).toBe('passed');
    }
  }, 600_000);
});
