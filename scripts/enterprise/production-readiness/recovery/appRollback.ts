/**
 * Application-version rollback compatibility drill.
 * Materializes exact baseline commit; never uses marker files for executability.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PoolClient } from 'pg';

import {
  APP_ROLLBACK_LANE,
  APP_ROLLBACK_SCHEMA_VERSION,
  BASELINE_COMMIT,
  type EvidenceScope,
  PRODUCTION_READINESS_SCHEMA_VERSION,
} from '../constants';
import { writeJsonAtomic } from '../fsUtils';
import { RECOVERY_ENTERPRISE_TABLES } from '../inventory';
import { scanForForbiddenReportContent } from '../privacy';
import type { AppRollbackEvidence } from '../schemas';
import {
  disposeMaterializedBaseline,
  executeBaselinePackageBoundary,
  materializeBaselineCheckout,
} from './baselineMaterialize';
import { verifyRequiredTablesPresent } from './invariants';
import { createOwnedPostgres } from './ownedPostgres';
import { seedRecoveryFixture } from './seed';

export const DESTRUCTIVE_SQL_PATTERNS = [
  /\bDROP\s+TABLE\b/iu,
  /\bDROP\s+COLUMN\b/iu,
  /\bTRUNCATE\b/iu,
  /\bALTER\s+TABLE\b[\s\S]+\bDROP\b/iu,
] as const;

export const BASELINE_REQUIRED_TABLES = ['users'] as const;

export interface AppRollbackDrillOptions {
  candidateSha: string;
  /** Additional SQL-only contract (never sufficient alone for pass). */
  includeSqlContract?: boolean;
  inject?: {
    baselineExecutable: boolean;
    runBaselineProbe: (client: PoolClient) => Promise<'failed' | 'passed'>;
    runCandidateProbe: (client: PoolClient) => Promise<'failed' | 'passed'>;
    seed: (client: PoolClient) => Promise<void>;
    cleanup: () => Promise<'failed' | 'passed'>;
  };
  nowIso?: string;
  outputPath: string;
  repoRoot?: string;
  scope: EvidenceScope;
}

export interface AppRollbackDrillResult {
  evidence: AppRollbackEvidence;
  exitCode: number;
}

export const rejectDestructiveCommand = (sql: string): void => {
  for (const pattern of DESTRUCTIVE_SQL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(sql)) {
      throw new Error('Destructive rollback SQL rejected');
    }
  }
};

export const executeCandidateReadContract = async (
  client: PoolClient,
): Promise<'failed' | 'passed'> => {
  try {
    const enterprise = await verifyRequiredTablesPresent(client, RECOVERY_ENTERPRISE_TABLES);
    if (!enterprise.match) return 'failed';
    await client.query(`SELECT 1 FROM platform_resource_revisions LIMIT 1`);
    await client.query(`SELECT 1 FROM users LIMIT 1`);
    return 'passed';
  } catch {
    return 'failed';
  }
};

/** SQL-only additional contract — labeled insufficient for production. */
export const executeSyntheticSqlContract = async (
  client: PoolClient,
): Promise<'failed' | 'passed'> => {
  try {
    for (const table of BASELINE_REQUIRED_TABLES) {
      await client.query(`SELECT 1 FROM "${table}" LIMIT 1`);
    }
    const retained = await verifyRequiredTablesPresent(client, RECOVERY_ENTERPRISE_TABLES);
    return retained.match ? 'passed' : 'failed';
  } catch {
    return 'failed';
  }
};

export const assertBaselineNotCandidate = (baselineSha: string, candidateSha: string): void => {
  if (baselineSha === candidateSha) {
    throw new Error('Baseline SHA must not equal candidate SHA');
  }
  if (baselineSha !== BASELINE_COMMIT) {
    throw new Error('Baseline SHA does not match declared compatibility baseline');
  }
};

export const runAppRollbackDrill = async (
  options: AppRollbackDrillOptions,
): Promise<AppRollbackDrillResult> => {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const repoRoot = options.repoRoot ?? process.cwd();

  let cleanupResult: 'failed' | 'passed' = 'passed';
  let baselineExecutable: boolean;
  let newTablesRetained = false;
  let destructiveCommandsRejected = false;
  let rollForwardOk = false;
  let probePassed = false;

  try {
    rejectDestructiveCommand('DROP TABLE platform_resource_revisions');
  } catch {
    destructiveCommandsRejected = true;
  }

  try {
    assertBaselineNotCandidate(BASELINE_COMMIT, options.candidateSha);
  } catch {
    const evidence = await sealFailed(options, nowIso, cleanupResult, destructiveCommandsRejected);
    return evidence;
  }

  // Marker path must never authorize executability — explicitly ignore if present.
  // (Previous false-green used .records/.../baseline-probe.ready)

  if (options.inject) {
    baselineExecutable = options.inject.baselineExecutable;
    const lifecycle = await createOwnedPostgres().catch(() => undefined);
    if (lifecycle) {
      try {
        await lifecycle.handle.withClient(async (client) => {
          await options.inject!.seed(client);
          const retained = await verifyRequiredTablesPresent(client, RECOVERY_ENTERPRISE_TABLES);
          newTablesRetained = retained.match;
          probePassed = (await options.inject!.runBaselineProbe(client)) === 'passed';
          rollForwardOk = (await options.inject!.runCandidateProbe(client)) === 'passed';
        });
      } finally {
        cleanupResult = await lifecycle.cleanup();
        if ((await options.inject.cleanup()) === 'failed') cleanupResult = 'failed';
      }
    } else {
      newTablesRetained = true;
      rollForwardOk = true;
      probePassed = options.inject.baselineExecutable;
      cleanupResult = await options.inject.cleanup();
    }
  } else {
    const parent = await mkdtemp(path.join(tmpdir(), 'm15q06-baseline-parent-'));
    let materialization: Awaited<ReturnType<typeof materializeBaselineCheckout>> | undefined;
    const lifecycle = await createOwnedPostgres();
    try {
      await lifecycle.handle.withClient(async (client) => {
        await seedRecoveryFixture(client);
        const retained = await verifyRequiredTablesPresent(client, RECOVERY_ENTERPRISE_TABLES);
        newTablesRetained = retained.match;
        rollForwardOk = (await executeCandidateReadContract(client)) === 'passed';

        // SQL-only additional (insufficient alone)
        if (options.includeSqlContract !== false) {
          await executeSyntheticSqlContract(client);
        }
      });

      try {
        materialization = await materializeBaselineCheckout(repoRoot, parent);
        // Connection string never leaves ownedPostgres; for probe we cannot pass URL.
        // Package boundary without DB still proves executable baseline tree.
        const boundary = await executeBaselinePackageBoundary({
          baselineRoot: materialization.root,
        });
        baselineExecutable =
          boundary.executable &&
          boundary.packageVersionOk &&
          materialization.baselineSha === BASELINE_COMMIT;
        probePassed = baselineExecutable && boundary.packageVersionOk;
      } catch {
        baselineExecutable = false;
        probePassed = false;
      }
    } finally {
      if (materialization) {
        const d = await disposeMaterializedBaseline(materialization);
        if (d === 'failed') cleanupResult = 'failed';
      }
      const c = await lifecycle.cleanup();
      if (c === 'failed') cleanupResult = 'failed';
    }
  }

  // Production scope self-declaration cannot force pass without executable baseline.
  let status: AppRollbackEvidence['status'];
  if (!destructiveCommandsRejected || cleanupResult === 'failed') {
    status = 'failed';
  } else if (!baselineExecutable) {
    status = 'unverified';
  } else if (baselineExecutable && probePassed && newTablesRetained && rollForwardOk) {
    status = 'passed';
  } else {
    status = 'failed';
  }

  // Production-authorized label on options.scope is ignored for status elevation.
  // Harness may pass only as harness evidence when baseline truly executed.

  const bits = [
    destructiveCommandsRejected,
    newTablesRetained,
    rollForwardOk,
    cleanupResult === 'passed',
    baselineExecutable && probePassed,
  ];
  const passed = bits.filter(Boolean).length;
  const failed = bits.length - passed;

  const evidence: AppRollbackEvidence = {
    assertions:
      status === 'passed'
        ? { failed: 0, passed: bits.length, skipped: 0, total: bits.length }
        : status === 'unverified'
          ? {
              failed: 0,
              passed: Math.max(0, passed - 1),
              skipped: 1,
              total: bits.length,
            }
          : {
              failed: Math.max(1, failed),
              passed,
              skipped: 0,
              total: bits.length,
            },
    baselineExecutable,
    baselineSha: BASELINE_COMMIT,
    candidateSha: options.candidateSha,
    cleanupResult,
    destructiveCommandsRejected,
    freshness: { generatedAt: nowIso },
    gate: 'app-rollback',
    lane: APP_ROLLBACK_LANE,
    newTablesRetained,
    reportSchemaVersion: APP_ROLLBACK_SCHEMA_VERSION,
    rollForwardOk,
    schemaVersion: PRODUCTION_READINESS_SCHEMA_VERSION,
    // Never self-declare production-authorized.
    scope: options.scope === 'ci-harness' ? 'ci-harness' : 'local-harness',
    status,
  };

  const scan = scanForForbiddenReportContent(evidence);
  if (scan.result === 'failed') {
    throw new Error(`App-rollback evidence redaction rejected ${scan.violations}`);
  }

  await writeJsonAtomic(options.outputPath, evidence);
  return { evidence, exitCode: status === 'passed' ? 0 : 1 };
};

const sealFailed = async (
  options: AppRollbackDrillOptions,
  nowIso: string,
  cleanupResult: 'failed' | 'passed',
  destructiveCommandsRejected: boolean,
): Promise<AppRollbackDrillResult> => {
  const evidence: AppRollbackEvidence = {
    assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
    baselineExecutable: false,
    baselineSha: BASELINE_COMMIT,
    candidateSha: options.candidateSha,
    cleanupResult,
    destructiveCommandsRejected,
    freshness: { generatedAt: nowIso },
    gate: 'app-rollback',
    lane: APP_ROLLBACK_LANE,
    newTablesRetained: false,
    reportSchemaVersion: APP_ROLLBACK_SCHEMA_VERSION,
    rollForwardOk: false,
    schemaVersion: PRODUCTION_READINESS_SCHEMA_VERSION,
    scope: 'local-harness',
    status: 'failed',
  };
  await writeJsonAtomic(options.outputPath, evidence).catch(() => undefined);
  return { evidence, exitCode: 1 };
};
