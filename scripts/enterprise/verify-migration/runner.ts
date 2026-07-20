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
  countAppliedMigrations,
  recordVerificationRun,
  verifyAuditInfrastructure,
  verifyCoreForeignKeys,
  verifyCoreRowCounts,
  verifyRevisionInfrastructure,
  verifySecretReferenceInvariants,
} from './invariants';
import {
  applyMigrationEntries,
  baselineEntries,
  postBaselineEntries,
  verifyExpandOnlyPostBaselineSql,
} from './migrations';
import type { OwnedPostgresLifecycle } from './ownedPostgres';
import { createOwnedPostgres } from './ownedPostgres';

export interface VerifyMigrationOptions {
  /**
   * Optional factory override for tests. Production always uses random owned containers.
   */
  createOwnedPostgres?: () => Promise<OwnedPostgresLifecycle>;
  externalDump?: ExternalDumpInput;
  /**
   * When true, re-invoke invariant checks on the same owned DB after the first
   * successful pass (idempotent re-run). Default true.
   */
  idempotentRerun?: boolean;
  repoRoot: string;
}

export interface VerifyMigrationResult {
  report: MigrationCompatReport;
}

const timed = async <T>(
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

export const runMigrationCompatVerification = async (
  options: VerifyMigrationOptions,
): Promise<VerifyMigrationResult> => {
  const started = Date.now();
  const { repoRoot } = options;
  const checks: CheckEntry[] = [];
  let cleanupResult: 'failed' | 'passed' = 'failed';
  let resourceId: string | undefined;
  let syntheticResult: 'failed' | 'passed' = 'failed';
  let fixtureStatus: 'failed' | 'loaded' | 'skipped' = 'skipped';
  let fixtureRowCounts: Record<string, number> = {};
  let ownedLifecycle: OwnedPostgresLifecycle | undefined;
  const provisionOwnedPostgres = options.createOwnedPostgres ?? createOwnedPostgres;

  const dumpResult = await loadExternalDump(options.externalDump);
  const externalDumpFields = toExternalDumpReportFields(dumpResult);

  const headSha = resolveHeadSha(repoRoot);
  const journalEntries = allJournalEntries(repoRoot);
  const postBaseline = postBaselineEntries(repoRoot);

  try {
    assertSyntheticFixtureIsSecretFree();

    const baselineCheck = await timed('baseline', async () => {
      const result = verifyBaseline(repoRoot);
      return result.match === 'passed';
    });
    checks.push(baselineCheck);

    const journalCheck = await timed('journal-snapshot', async () => {
      const result = verifyJournalSnapshotAlignment(repoRoot);
      return result.match;
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
      cleanupResult = 'passed'; // nothing provisioned
      checks.push({
        category: 'cleanup',
        durationMs: 0,
        result: 'passed',
      });
      checks.push({
        category: 'rerun',
        durationMs: 0,
        result: 'skipped',
      });
    } else {
      ownedLifecycle = await provisionOwnedPostgres();
      resourceId = ownedLifecycle.handle.resourceToken;

      const applyBaselineCheck = await timed('apply-baseline', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const summary = await applyMigrationEntries(client, repoRoot, baselineEntries(repoRoot));
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
          fixtureStatus = counts.match ? 'loaded' : 'failed';
          return counts.match;
        }),
      );
      checks.push(loadFixtureCheck);
      if (loadFixtureCheck.result !== 'passed') fixtureStatus = 'failed';
      else fixtureStatus = 'loaded';

      const applyPostCheck = await timed('apply-post-baseline', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const summary = await applyMigrationEntries(client, repoRoot, postBaseline);
          const applied = await countAppliedMigrations(client);
          return summary.appliedCount === postBaseline.length && applied === journalEntries.length;
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
          return result.match;
        }),
      );
      checks.push(revisionCheck);

      const auditCheck = await timed('audit', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const result = await verifyAuditInfrastructure(client);
          return result.match;
        }),
      );
      checks.push(auditCheck);

      const secretRefCheck = await timed('secret-reference', async () =>
        ownedLifecycle!.handle.withClient(async (client) => {
          const result = await verifySecretReferenceInvariants(client);
          return result.match;
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

      const rerunEnabled = options.idempotentRerun !== false;
      const rerunCheck = await timed('rerun', async () => {
        if (!rerunEnabled || !syntheticChecksPassed) return { match: true, unverified: false };

        return ownedLifecycle!.handle.withClient(async (client) => {
          const runId = 'synthetic-chain-v1';
          const first = await recordVerificationRun(client, runId);
          if (first !== 'first') return false;

          // Idempotent re-check of invariants (no second fixture load required).
          const row = await verifyCoreRowCounts(client, SYNTHETIC_FIXTURE_ROW_COUNTS);
          const fk = await verifyCoreForeignKeys(client);
          const rev = await verifyRevisionInfrastructure(client);
          const audit = await verifyAuditInfrastructure(client);
          const secrets = await verifySecretReferenceInvariants(client);
          const second = await recordVerificationRun(client, runId);
          // Second observation of the same run id is an expected rerun; must not insert again.
          if (second !== 'rerun') return false;
          return row.match && fk.match && rev.match && audit.match && secrets.match;
        });
      });
      checks.push(rerunCheck);

      if (
        syntheticChecksPassed &&
        baselineCheck.result === 'passed' &&
        journalCheck.result === 'passed' &&
        expandOnlyCheck.result === 'passed' &&
        (rerunCheck.result === 'passed' || rerunCheck.result === 'skipped')
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
      // Cleanup failure is failure for synthetic result.
      if (cleanupResult === 'failed') syntheticResult = 'failed';
    }
  } catch {
    syntheticResult = 'failed';
    if (ownedLifecycle) {
      const cleanupStarted = Date.now();
      cleanupResult = await ownedLifecycle.cleanup();
      checks.push({
        category: 'cleanup',
        durationMs: Date.now() - cleanupStarted,
        result: cleanupResult === 'passed' ? 'passed' : 'failed',
      });
    } else if (!checks.some((check) => check.category === 'cleanup')) {
      cleanupResult = 'passed';
      checks.push({ category: 'cleanup', durationMs: 0, result: 'passed' });
    }
    if (!checks.some((check) => check.category === 'rerun')) {
      checks.push({ category: 'rerun', durationMs: 0, result: 'skipped' });
    }
  }

  const overall = deriveOverallResult({
    cleanupResult,
    externalDumpStatus: externalDumpFields.status,
    syntheticResult,
  });

  const report = createMigrationCompatReport({
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
      // Wave2-A only loads the synthetic fixture; dump intake is privacy-only.
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

  return { report };
};

/** Deterministic token for unit tests of resource naming only. */
export const peekResourceTokenShape = (): string => `m15q03_${randomBytes(8).toString('hex')}`;
