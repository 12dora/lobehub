/**
 * Application-version rollback drill with real baseline materialization + DB probe.
 */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
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
import { createToolOwnedTempDir, writeJsonAtomic } from '../fsUtils';
import { RECOVERY_ENTERPRISE_TABLES } from '../inventory';
import { scanForForbiddenReportContent } from '../privacy';
import type { AppRollbackEvidence } from '../schemas';
import {
  disposeOwnedParent,
  executeBaselineDbProbe,
  materializeBaselineCheckout,
} from './baselineMaterialize';
import { toPreflightGateEvidence } from './evidenceEnvelope';
import { verifyRequiredTablesPresent } from './invariants';
import { createOwnedPostgres } from './ownedPostgres';
import { seedRecoveryFixture } from './seed';

export const DESTRUCTIVE_SQL_PATTERNS = [
  /\bDROP\s+TABLE\b/iu,
  /\bDROP\s+COLUMN\b/iu,
  /\bTRUNCATE\b/iu,
  /\bALTER\s+TABLE\b[\s\S]+\bDROP\b/iu,
] as const;

export const BASELINE_REQUIRED_TABLES = [
  'users',
  'sessions',
  'agents',
  'topics',
  'messages',
  'user_settings',
  'api_keys',
] as const;

export interface AppRollbackDrillOptions {
  candidateSha: string;
  nowIso?: string;
  outputPath: string;
  releaseId?: string;
  repoRoot?: string;
  scope: EvidenceScope;
}

export interface AppRollbackDrillResult {
  evidence: AppRollbackEvidence;
  exitCode: number;
  /** Preflight-consumable gate evidence envelope. */
  gateEvidence: ReturnType<typeof toPreflightGateEvidence>;
}

export const rejectDestructiveCommand = (sql: string): void => {
  for (const pattern of DESTRUCTIVE_SQL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(sql)) throw new Error('Destructive rollback SQL rejected');
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

export const assertBaselineNotCandidate = (baselineSha: string, candidateSha: string): void => {
  if (baselineSha === candidateSha) throw new Error('Baseline SHA must not equal candidate SHA');
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
  let probePassed: boolean;

  try {
    rejectDestructiveCommand('DROP TABLE platform_resource_revisions');
  } catch {
    destructiveCommandsRejected = true;
  }

  try {
    assertBaselineNotCandidate(BASELINE_COMMIT, options.candidateSha);
  } catch {
    return seal(options, nowIso, {
      baselineExecutable: false,
      cleanupResult,
      destructiveCommandsRejected,
      newTablesRetained: false,
      probePassed: false,
      rollForwardOk: false,
      status: 'failed',
    });
  }

  // Owned parent for baseline tree (strong ownership + cleanup).
  const parentReal = await realpath(tmpdir());
  const parentOwned = await createToolOwnedTempDir(parentReal);
  const lifecycle = await createOwnedPostgres();

  try {
    await lifecycle.handle.withClient(async (client) => {
      await seedRecoveryFixture(client);
      const retained = await verifyRequiredTablesPresent(client, RECOVERY_ENTERPRISE_TABLES);
      newTablesRetained = retained.match;
      rollForwardOk = (await executeCandidateReadContract(client)) === 'passed';
    });

    try {
      const materialization = await materializeBaselineCheckout(repoRoot, parentOwned);
      const hostRequireRoot = path.resolve(repoRoot);
      const probe = await lifecycle.handle.withDatabaseUrl(async (databaseUrl) =>
        executeBaselineDbProbe({
          baselineRoot: materialization.root,
          databaseUrl,
          hostRequireRoot,
        }),
      );
      baselineExecutable =
        probe.executable &&
        probe.packageVersionOk &&
        probe.legacyReadOk &&
        probe.enterpriseRetainedOk &&
        materialization.baselineSha === BASELINE_COMMIT;
      probePassed = baselineExecutable;
    } catch {
      baselineExecutable = false;
      probePassed = false;
    }
  } finally {
    const parentCleanup = await disposeOwnedParent(parentOwned);
    if (parentCleanup === 'failed') cleanupResult = 'failed';
    const c = await lifecycle.cleanup();
    if (c === 'failed') cleanupResult = 'failed';
  }

  let status: AppRollbackEvidence['status'];
  if (!destructiveCommandsRejected || cleanupResult === 'failed') status = 'failed';
  else if (!baselineExecutable) status = 'unverified';
  else if (probePassed && newTablesRetained && rollForwardOk) status = 'passed';
  else status = 'failed';

  const bits = [
    destructiveCommandsRejected,
    newTablesRetained,
    rollForwardOk,
    cleanupResult === 'passed',
    baselineExecutable && probePassed,
  ];
  const passed = bits.filter(Boolean).length;

  const evidence: AppRollbackEvidence = {
    assertions:
      status === 'passed'
        ? { failed: 0, passed: bits.length, skipped: 0, total: bits.length }
        : status === 'unverified'
          ? { failed: 0, passed: Math.max(0, passed - 1), skipped: 1, total: bits.length }
          : {
              failed: Math.max(1, bits.length - passed),
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
    scope: options.scope === 'ci-harness' ? 'ci-harness' : 'local-harness',
    status,
  };

  if (scanForForbiddenReportContent(evidence).result === 'failed') {
    throw new Error('App-rollback evidence redaction rejected');
  }

  // Write raw report then wrap for preflight.
  const rawPath = options.outputPath.endsWith('.json')
    ? options.outputPath.replace(/\.json$/u, '.raw.json')
    : `${options.outputPath}.raw.json`;
  const { sha256: artifactSha256 } = await writeJsonAtomic(rawPath, evidence);
  const gateEvidence = toPreflightGateEvidence({
    artifactSha256,
    candidateSha: options.candidateSha,
    gate: 'app-rollback',
    generatedAt: nowIso,
    releaseId: options.releaseId,
    rawReport: evidence,
    scope: evidence.scope,
    status: evidence.status,
    assertions: evidence.assertions,
  });
  await writeJsonAtomic(options.outputPath, gateEvidence);

  return {
    evidence,
    exitCode: status === 'passed' ? 0 : 1,
    gateEvidence,
  };
};

const seal = async (
  options: AppRollbackDrillOptions,
  nowIso: string,
  state: {
    baselineExecutable: boolean;
    cleanupResult: 'failed' | 'passed';
    destructiveCommandsRejected: boolean;
    newTablesRetained: boolean;
    probePassed: boolean;
    rollForwardOk: boolean;
    status: AppRollbackEvidence['status'];
  },
): Promise<AppRollbackDrillResult> => {
  const evidence: AppRollbackEvidence = {
    assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
    baselineExecutable: state.baselineExecutable,
    baselineSha: BASELINE_COMMIT,
    candidateSha: options.candidateSha,
    cleanupResult: state.cleanupResult,
    destructiveCommandsRejected: state.destructiveCommandsRejected,
    freshness: { generatedAt: nowIso },
    gate: 'app-rollback',
    lane: APP_ROLLBACK_LANE,
    newTablesRetained: state.newTablesRetained,
    reportSchemaVersion: APP_ROLLBACK_SCHEMA_VERSION,
    rollForwardOk: state.rollForwardOk,
    schemaVersion: PRODUCTION_READINESS_SCHEMA_VERSION,
    scope: 'local-harness',
    status: state.status,
  };
  const rawPath = options.outputPath.replace(/\.json$/u, '.raw.json');
  const { sha256 } = await writeJsonAtomic(rawPath, evidence).catch(async () => {
    await writeJsonAtomic(options.outputPath, evidence);
    return { sha256: createHash('sha256').update('').digest('hex') };
  });
  const gateEvidence = toPreflightGateEvidence({
    artifactSha256: sha256,
    candidateSha: options.candidateSha,
    gate: 'app-rollback',
    generatedAt: nowIso,
    rawReport: evidence,
    scope: 'local-harness',
    status: state.status,
    assertions: evidence.assertions,
  });
  await writeJsonAtomic(options.outputPath, gateEvidence).catch(() => undefined);
  return { evidence, exitCode: 1, gateEvidence };
};
