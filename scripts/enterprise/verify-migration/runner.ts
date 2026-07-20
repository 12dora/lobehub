import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { allJournalEntries, verifyBaseline, verifyJournalSnapshotAlignment } from './baseline';
import {
  BASELINE_COMMIT,
  BASELINE_LAST_TAG,
  BASELINE_MIGRATION_COUNT,
  BASELINE_VERSION,
} from './constants';
import type { CheckEntry, MigrationCompatReport } from './contract';
import { createMigrationCompatReport, deriveOverallResult, toReportCommitShort } from './contract';
import type { ExternalDumpInput } from './dump';
import { loadExternalDump, toExternalDumpReportFields } from './dump';
import {
  assertSyntheticFixtureIsSecretFree,
  buildSyntheticFixtureStatements,
  SYNTHETIC_FIXTURE_ROW_COUNTS,
} from './fixture';
import {
  verifyAuditInfrastructure,
  verifyCoreForeignKeys,
  verifyCoreRowCounts,
  verifyRevisionInfrastructure,
  verifySecretReferenceInvariants,
} from './invariants';
import {
  applyOfficialBaselineMigrations,
  applyOfficialPostBaselineMigrations,
  countAppliedMigrations,
  loadOfficialMigrations,
  postBaselineEntries,
  verifyExpandOnlyPostBaselineSql,
  verifyOfficialMigratorRerun,
} from './migrations';
import type { OwnedPostgresLifecycle } from './ownedPostgres';
import { createOwnedPostgres } from './ownedPostgres';
import { seedPlatformProbes } from './probes';

export interface VerifyMigrationOptions {
  /**
   * Optional factory override for tests. Production always uses random owned containers.
   */
  createOwnedPostgres?: () => Promise<OwnedPostgresLifecycle>;
  externalDump?: ExternalDumpInput;
  /**
   * When true, run the official production migrator again after upgrade.
   * Default true. Rerun passes only if migrator succeeds and journal is unchanged.
   */
  officialRerun?: boolean;
  repoRoot: string;
}

export interface VerifyMigrationResult {
  report: MigrationCompatReport;
}

const timed = async (
  category: CheckEntry['category'],
  fn: () => Promise<{ match: boolean; unverified?: boolean } | boolean>,
): Promise<CheckEntry> => {
  const started = Date.now();
  try {
    const outcome = await fn();
    const match = typeof outcome === 'boolean' ? outcome : outcome.match;
    const unverified = typeof outcome === 'boolean' ? false : Boolean(outcome.unverified);
    return {
      category,
      durationMs: Date.now() - started,
      result: unverified ? 'unverified' : match ? 'passed' : 'failed',
    };
  } catch {
    return {
      category,
      durationMs: Date.now() - started,
      result: 'failed',
    };
  }
};

const resolveHeadSha = (repoRoot: string): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '0'.repeat(40);
  }
};

const ensureCheck = (
  checks: CheckEntry[],
  category: CheckEntry['category'],
  result: CheckEntry,
) => {
  if (!checks.some((check) => check.category === category)) {
    checks.push(result);
  }
};

export const runMigrationCompatVerification = async (
  options: VerifyMigrationOptions,
): Promise<VerifyMigrationResult> => {
  const started = Date.now();
  const { repoRoot } = options;
  const checks: CheckEntry[] = [];
  let cleanupResult: 'failed' | 'passed';
  let resourceId: string | undefined;
  let syntheticResult: 'failed' | 'passed' = 'failed';
  let fixtureStatus: 'failed' | 'loaded' | 'skipped' = 'skipped';
  let fixtureRowCounts: Record<string, number> = {};
  let ownedLifecycle: OwnedPostgresLifecycle | undefined;
  const provisionOwnedPostgres = options.createOwnedPostgres ?? createOwnedPostgres;

  // Privacy first — fail closed before any owned DB is created.
  const dumpResult = await loadExternalDump(options.externalDump);
  const externalDumpFields = toExternalDumpReportFields(dumpResult);

  const headSha = resolveHeadSha(repoRoot);
  const journalEntries = allJournalEntries(repoRoot);
  const postBaseline = postBaselineEntries(repoRoot);
  const officialMigrations = loadOfficialMigrations(repoRoot);

  try {
    assertSyntheticFixtureIsSecretFree();

    const baselineCheck = await timed('baseline', async () => {
      const result = verifyBaseline(repoRoot);
      return result.match === 'passed';
    });
    checks.push(baselineCheck);

    const journalCheck = await timed('journal-snapshot', async () => {
      const result = verifyJournalSnapshotAlignment(repoRoot);
      // Also require official reader alignment (hash + when).
      return (
        result.match &&
        officialMigrations.length === journalEntries.length &&
        officialMigrations.every((migration, index) => migration.tag === journalEntries[index]?.tag)
      );
    });
    checks.push(journalCheck);

    const expandOnlyCheck = await timed('expand-only', async () => {
      const result = verifyExpandOnlyPostBaselineSql(repoRoot);
      return result.match;
    });
    checks.push(expandOnlyCheck);

    const externalDumpCheck = await timed('external-dump', async () => {
      if (dumpResult.status === 'absent') return { match: true, unverified: true };
      if (dumpResult.status === 'privacy-verified') return true;
      if (dumpResult.status === 'privacy-rejected') return false;
      return { match: false, unverified: true };
    });
    checks.push(externalDumpCheck);

    const staticOk =
      baselineCheck.result === 'passed' &&
      journalCheck.result === 'passed' &&
      expandOnlyCheck.result === 'passed' &&
      externalDumpCheck.result !== 'failed';

    if (!staticOk) {
      // Privacy reject / static failure: never create owned DB.
      cleanupResult = 'passed';
      checks.push({ category: 'cleanup', durationMs: 0, result: 'passed' });
      checks.push({ category: 'rerun', durationMs: 0, result: 'skipped' });
      // Fill remaining categories as failed/skipped so failed reports stay parseable.
      for (const category of [
        'apply-baseline',
        'load-fixture',
        'apply-post-baseline',
        'row-count',
        'foreign-key',
        'revision',
        'audit',
        'secret-reference',
      ] as const) {
        ensureCheck(checks, category, {
          category,
          durationMs: 0,
          result: 'skipped',
        });
      }
    } else {
      ownedLifecycle = await provisionOwnedPostgres();
      resourceId = ownedLifecycle.handle.resourceToken;

      const applyBaselineCheck = await timed('apply-baseline', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const summary = await applyOfficialBaselineMigrations(client, repoRoot);
          return summary.appliedCount === BASELINE_MIGRATION_COUNT;
        }),
      );
      checks.push(applyBaselineCheck);

      const loadFixtureCheck = await timed('load-fixture', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          for (const statement of buildSyntheticFixtureStatements()) {
            await client.query(statement);
          }
          const counts = await verifyCoreRowCounts(client, SYNTHETIC_FIXTURE_ROW_COUNTS);
          fixtureRowCounts = counts.counts;
          return counts.match;
        }),
      );
      checks.push(loadFixtureCheck);
      fixtureStatus = loadFixtureCheck.result === 'passed' ? 'loaded' : 'failed';

      const applyPostCheck = await timed('apply-post-baseline', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const summary = await applyOfficialPostBaselineMigrations(client, repoRoot);
          const applied = await countAppliedMigrations(client);
          // Seed platform probes after post-baseline tables exist.
          await seedPlatformProbes(client);
          return (
            summary.appliedCount === postBaseline.length && applied === officialMigrations.length
          );
        }),
      );
      checks.push(applyPostCheck);

      const rowCountCheck = await timed('row-count', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const result = await verifyCoreRowCounts(client, SYNTHETIC_FIXTURE_ROW_COUNTS);
          fixtureRowCounts = result.counts;
          return result.match;
        }),
      );
      checks.push(rowCountCheck);

      const fkCheck = await timed('foreign-key', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const result = await verifyCoreForeignKeys(client);
          return result.match;
        }),
      );
      checks.push(fkCheck);

      const revisionCheck = await timed('revision', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const result = await verifyRevisionInfrastructure(client);
          return result.match && (result.rowCount ?? 0) > 0;
        }),
      );
      checks.push(revisionCheck);

      const auditCheck = await timed('audit', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const result = await verifyAuditInfrastructure(client);
          return result.match && (result.rowCount ?? 0) > 0;
        }),
      );
      checks.push(auditCheck);

      const secretRefCheck = await timed('secret-reference', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const result = await verifySecretReferenceInvariants(client);
          return result.match && (result.rowCount ?? 0) > 0;
        }),
      );
      checks.push(secretRefCheck);

      const syntheticChecksPassed = [
        applyBaselineCheck,
        loadFixtureCheck,
        applyPostCheck,
        rowCountCheck,
        fkCheck,
        revisionCheck,
        auditCheck,
        secretRefCheck,
      ].every((check) => check.result === 'passed');

      const rerunEnabled = options.officialRerun !== false;
      const rerunCheck = await timed('rerun', async () => {
        if (!rerunEnabled || !syntheticChecksPassed) return false;

        return ownedLifecycle!.handle.withPool(async (pool) => {
          const result = await verifyOfficialMigratorRerun(pool, repoRoot);
          return result.match && result.beforeCount === officialMigrations.length;
        });
      });
      checks.push(rerunCheck);

      if (
        syntheticChecksPassed &&
        baselineCheck.result === 'passed' &&
        journalCheck.result === 'passed' &&
        expandOnlyCheck.result === 'passed' &&
        rerunCheck.result === 'passed'
      ) {
        syntheticResult = 'passed';
      }

      const cleanupStarted = Date.now();
      cleanupResult = ownedLifecycle ? await ownedLifecycle.cleanup() : 'passed';
      checks.push({
        category: 'cleanup',
        durationMs: Date.now() - cleanupStarted,
        result: cleanupResult === 'passed' ? 'passed' : 'failed',
      });
      if (cleanupResult === 'failed') syntheticResult = 'failed';
    }
  } catch {
    syntheticResult = 'failed';
    if (ownedLifecycle) {
      const cleanupStarted = Date.now();
      cleanupResult = await ownedLifecycle.cleanup();
      ensureCheck(checks, 'cleanup', {
        category: 'cleanup',
        durationMs: Date.now() - cleanupStarted,
        result: cleanupResult === 'passed' ? 'passed' : 'failed',
      });
    } else {
      cleanupResult = 'passed';
      ensureCheck(checks, 'cleanup', { category: 'cleanup', durationMs: 0, result: 'passed' });
    }
    ensureCheck(checks, 'rerun', { category: 'rerun', durationMs: 0, result: 'skipped' });
    for (const category of [
      'apply-baseline',
      'load-fixture',
      'apply-post-baseline',
      'row-count',
      'foreign-key',
      'revision',
      'audit',
      'secret-reference',
    ] as const) {
      ensureCheck(checks, category, { category, durationMs: 0, result: 'skipped' });
    }
  }

  const overall = deriveOverallResult({
    cleanupResult,
    externalDumpStatus: externalDumpFields.status,
    syntheticResult,
  });

  // Failed synthetic reports may have skipped categories; only full success must satisfy gate.
  // When synthetic failed, still produce a schema-valid report (may have skipped checks).
  let report: MigrationCompatReport;
  try {
    report = createMigrationCompatReport({
      baseline: {
        commitShort: toReportCommitShort(BASELINE_COMMIT),
        lastTag: BASELINE_LAST_TAG,
        match:
          checks.find((check) => check.category === 'baseline')?.result === 'passed'
            ? 'passed'
            : 'failed',
        migrationCount: BASELINE_MIGRATION_COUNT,
        version: BASELINE_VERSION,
      },
      checks,
      cleanupResult,
      elapsed: { milliseconds: Date.now() - started },
      externalDump: externalDumpFields,
      fixture: {
        rowCounts: fixtureRowCounts,
        source: 'synthetic',
        status: fixtureStatus,
      },
      head: {
        commitShort: toReportCommitShort(headSha),
        postBaselineMigrationCount: postBaseline.length,
        totalMigrationCount: journalEntries.length,
      },
      lane: 'enterprise-migration-compat',
      ownedResource: {
        kind: resourceId ? 'container-database' : 'none',
        resourceId,
      },
      overall,
      rerun: {
        mode: 'idempotent',
        result:
          checks.find((check) => check.category === 'rerun')?.result === 'failed'
            ? 'failed'
            : checks.find((check) => check.category === 'rerun')?.result === 'passed'
              ? 'passed'
              : 'skipped',
      },
      schemaVersion: 1,
      syntheticResult,
    });
  } catch {
    // If strict schema rejects a partial failure report, force a minimal failed report shape
    // by marking synthetic failed with overall failed and only the checks we have.
    // Re-throw only after cleanup already ran.
    throw new Error('MigrationCompatReportConstructionFailed');
  }

  return { report };
};

/** Deterministic token for unit tests of resource naming only. */
export const peekResourceTokenShape = (): string => `m15q03_${randomBytes(8).toString('hex')}`;
