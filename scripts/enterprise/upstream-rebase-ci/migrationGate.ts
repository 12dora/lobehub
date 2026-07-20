import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { GateResult } from './contract';
import { runProcess } from './process';

export const Q03_VERIFY_MIGRATION_ENTRY = 'scripts/enterprise/verify-migration.ts' as const;
export const Q03_VERIFY_MIGRATION_CONTRACT =
  'scripts/enterprise/verify-migration/contract.ts' as const;

/**
 * Categories required by reviewed Q03 Wave2-A synthetic foundation reports.
 * Mirrored for pre-merge fixture validation when the package is not yet on the tree.
 */
export const Q03_CHECK_CATEGORIES = [
  'baseline',
  'journal-snapshot',
  'apply-baseline',
  'load-fixture',
  'apply-post-baseline',
  'row-count',
  'foreign-key',
  'revision',
  'audit',
  'secret-reference',
  'expand-only',
  'external-dump',
  'cleanup',
  'rerun',
] as const;

export const Q03_REQUIRED_PASSING_CATEGORIES = Q03_CHECK_CATEGORIES.filter(
  (category) => category !== 'external-dump',
);

const pathExists = async (absolutePath: string) => {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
};

export const q03VerifierPaths = (repositoryRoot: string) => ({
  contract: path.join(repositoryRoot, Q03_VERIFY_MIGRATION_CONTRACT),
  entry: path.join(repositoryRoot, Q03_VERIFY_MIGRATION_ENTRY),
});

export const isQ03VerifierPresent = async (repositoryRoot: string): Promise<boolean> => {
  const { contract, entry } = q03VerifierPaths(repositoryRoot);
  return (await pathExists(entry)) && (await pathExists(contract));
};

/**
 * Pure Wave2-A synthetic foundation gate (mirrors Q03 `gatePassed`).
 * Does NOT claim overall production-dump pass or application-version rollback.
 */
export const evaluateQ03MigrationCompatEvidence = (report: unknown): boolean => {
  if (!report || typeof report !== 'object') return false;
  const data = report as Record<string, unknown>;

  if (data.lane !== 'enterprise-migration-compat') return false;
  if (data.schemaVersion !== 1) return false;
  if (data.overall === 'passed') return false; // reserved; Wave2-A never overall-passed
  if (data.syntheticResult !== 'passed') return false;
  if (data.overall !== 'unverified') return false;
  if (data.cleanupResult !== 'passed') return false;

  const baseline = data.baseline as Record<string, unknown> | undefined;
  if (!baseline || baseline.match !== 'passed') return false;

  const fixture = data.fixture as Record<string, unknown> | undefined;
  if (!fixture || fixture.status !== 'loaded' || fixture.source !== 'synthetic') return false;

  const rerun = data.rerun as Record<string, unknown> | undefined;
  if (!rerun || rerun.result !== 'passed') return false;

  const owned = data.ownedResource as Record<string, unknown> | undefined;
  if (!owned || owned.kind !== 'container-database' || typeof owned.resourceId !== 'string') {
    return false;
  }

  const redaction = data.redactionScan as Record<string, unknown> | undefined;
  if (!redaction || redaction.result !== 'passed' || redaction.violations !== 0) return false;

  const externalDump = data.externalDump as Record<string, unknown> | undefined;
  if (!externalDump || externalDump.status === 'privacy-rejected') return false;

  const checks = data.checks;
  if (!Array.isArray(checks) || checks.length !== Q03_CHECK_CATEGORIES.length) return false;

  const map = new Map<string, string>();
  for (const entry of checks) {
    if (!entry || typeof entry !== 'object') return false;
    const category = (entry as { category?: string }).category;
    const result = (entry as { result?: string }).result;
    if (!category || !result) return false;
    if (map.has(category)) return false;
    map.set(category, result);
  }

  for (const category of Q03_CHECK_CATEGORIES) {
    if (!map.has(category)) return false;
  }
  for (const category of Q03_REQUIRED_PASSING_CATEGORIES) {
    if (map.get(category) !== 'passed') return false;
  }
  const externalDumpResult = map.get('external-dump');
  if (externalDumpResult !== 'passed' && externalDumpResult !== 'unverified') return false;

  return true;
};

/** Prefer reviewed Q03 gatePassed when the package is on the tree. */
export const loadQ03GatePassed = async (
  repositoryRoot: string,
): Promise<((report: unknown) => boolean) | null> => {
  if (!(await isQ03VerifierPresent(repositoryRoot))) return null;
  try {
    const contractPath = q03VerifierPaths(repositoryRoot).contract;
    const module = await import(pathToFileURL(contractPath).href);
    if (typeof module.gatePassed === 'function') {
      return (report: unknown) => Boolean(module.gatePassed(report));
    }
  } catch {
    return null;
  }
  return null;
};

export const buildQ03PassingFixtureReport = (): Record<string, unknown> => ({
  baseline: {
    commitShort: '4bab1636408e',
    lastTag: '0116_add_task_connector_message_and_verify_updates',
    match: 'passed',
    migrationCount: 117,
    version: '2.2.10',
  },
  checks: Q03_CHECK_CATEGORIES.map((category) => ({
    category,
    durationMs: 1,
    result: category === 'external-dump' ? 'unverified' : 'passed',
  })),
  cleanupResult: 'passed',
  elapsed: { milliseconds: 10 },
  externalDump: { privacy: 'not-applicable', status: 'absent' },
  fixture: {
    rowCounts: { users: 1 },
    source: 'synthetic',
    status: 'loaded',
  },
  head: {
    commitShort: '8b0a0d8ab6e0',
    postBaselineMigrationCount: 19,
    totalMigrationCount: 136,
  },
  lane: 'enterprise-migration-compat',
  ownedResource: { kind: 'container-database', resourceId: `m15q03_${'a'.repeat(16)}` },
  overall: 'unverified',
  redactionScan: { result: 'passed', violations: 0 },
  rerun: { mode: 'idempotent', result: 'passed' },
  schemaVersion: 1,
  syntheticResult: 'passed',
});

export interface MigrationGateOptions {
  /**
   * Test seam: inject a pre-built Q03 report instead of running the verifier process.
   * Production callers omit this.
   */
  injectedReport?: unknown;
  rawDirectory: string;
  repositoryRoot: string;
}

/**
 * migration-upgrade-rollback gate for dry-run CI.
 *
 * Requires reviewed Q03 migration compatibility verifier evidence for the synthetic
 * owned-PostgreSQL upgrade/apply + official rerun foundation.
 * Does NOT claim application-version rollback or production-dump overall pass.
 * Journal / Migration-0 unit substitutes are never accepted.
 */
export const runMigrationUpgradeRollbackGate = async ({
  injectedReport,
  repositoryRoot,
}: MigrationGateOptions): Promise<GateResult> => {
  const present = await isQ03VerifierPresent(repositoryRoot);
  if (!present && injectedReport === undefined) {
    return {
      id: 'migration-upgrade-rollback',
      kind: 'command',
      outcome: 'failed',
      reason:
        'Q03 verify-migration is absent; migration-upgrade-rollback fails closed without a weak substitute.',
    };
  }

  let report: unknown = injectedReport;
  if (report === undefined) {
    const entry = q03VerifierPaths(repositoryRoot).entry;
    const processResult = await runProcess(
      ['bun', entry, '--repo-root', repositoryRoot, '--json'],
      repositoryRoot,
    );
    if (processResult.code !== 0 && processResult.code !== 1) {
      // exit 0 = synthetic foundation ok; 1 = synthetic failed; 2 = privacy
      return {
        id: 'migration-upgrade-rollback',
        kind: 'command',
        outcome: 'failed',
        reason: `Q03 verify-migration exited ${processResult.code}.`,
      };
    }
    try {
      report = JSON.parse(processResult.stdout);
    } catch {
      return {
        id: 'migration-upgrade-rollback',
        kind: 'command',
        outcome: 'failed',
        reason: 'Q03 verify-migration did not emit a parseable JSON report.',
      };
    }
  }

  const q03GatePassed = present ? await loadQ03GatePassed(repositoryRoot) : null;
  const passed = q03GatePassed ? q03GatePassed(report) : evaluateQ03MigrationCompatEvidence(report);

  if (!passed) {
    const overall =
      report && typeof report === 'object'
        ? String((report as { overall?: string }).overall ?? 'unknown')
        : 'unknown';
    const synthetic =
      report && typeof report === 'object'
        ? String((report as { syntheticResult?: string }).syntheticResult ?? 'unknown')
        : 'unknown';
    return {
      id: 'migration-upgrade-rollback',
      kind: 'command',
      outcome: 'failed',
      reason: `Q03 migration evidence rejected (overall=${overall}, synthetic=${synthetic}); no weak fallback.`,
    };
  }

  // Count only required-passing categories (external-dump may stay unverified).
  const requiredPassing = Q03_REQUIRED_PASSING_CATEGORIES.length;

  return {
    assertions: {
      failed: 0,
      passed: requiredPassing,
      skipped: 0,
      total: requiredPassing,
    },
    id: 'migration-upgrade-rollback',
    kind: 'command',
    outcome: 'passed',
    reason:
      'Q03 migration compatibility synthetic foundation passed (owned PG upgrade/apply/rerun; not app rollback or dump overall-pass).',
  };
};
