/**
 * Application-version rollback drill.
 * baselineExecutable is true only when real pinned-commit data-access code executes
 * a meaningful legacy DB read. Planted probes never authorize.
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
  executeBaselineUserModelBoundary,
  materializeBaselineCheckout,
} from './baselineMaterialize';
import { toPreflightGateEvidence } from './evidenceEnvelope';
import { verifyRequiredTablesPresent } from './invariants';
import { createOwnedPostgres } from './ownedPostgres';
import { RECOVERY_PROBE_IDS, seedRecoveryFixture } from './seed';

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
  baselineDetail?: string;
  evidence: AppRollbackEvidence;
  exitCode: number;
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
  let newTablesRetained = false;
  let destructiveCommandsRejected = false;
  let rollForwardOk = false;

  try {
    rejectDestructiveCommand('DROP TABLE platform_resource_revisions');
  } catch {
    destructiveCommandsRejected = true;
  }

  try {
    assertBaselineNotCandidate(BASELINE_COMMIT, options.candidateSha);
  } catch {
    return seal(options, nowIso, {
      baselineDetail: 'baseline-candidate-mismatch',
      baselineExecutable: false,
      cleanupResult,
      destructiveCommandsRejected,
      newTablesRetained: false,
      rollForwardOk: false,
      status: 'failed',
    });
  }

  const parentReal = await realpath(tmpdir());
  const parentOwned = await createToolOwnedTempDir(parentReal);
  const lifecycle = await createOwnedPostgres();

  let baselineExecutable: boolean;
  let baselineDetail: string;
  try {
    await lifecycle.handle.withClient(async (client) => {
      await seedRecoveryFixture(client);
      const retained = await verifyRequiredTablesPresent(client, RECOVERY_ENTERPRISE_TABLES);
      newTablesRetained = retained.match;
      rollForwardOk = (await executeCandidateReadContract(client)) === 'passed';
    });

    try {
      const materialization = await materializeBaselineCheckout(repoRoot, parentOwned);
      const execResult = await lifecycle.handle.withDatabaseUrl(async (databaseUrl) =>
        executeBaselineUserModelBoundary({
          baselineRoot: materialization.root,
          databaseUrl,
          hostRequireRoot: path.resolve(repoRoot),
          userId: RECOVERY_PROBE_IDS.userId,
        }),
      );
      baselineExecutable = execResult.baselineExecutable;
      baselineDetail = execResult.detail;
    } catch (error) {
      baselineExecutable = false;
      baselineDetail = error instanceof Error ? error.message : 'materialize-failed';
    }
  } catch (error) {
    baselineExecutable = false;
    baselineDetail = error instanceof Error ? error.message : 'seed-or-lifecycle-failed';
    newTablesRetained = false;
    rollForwardOk = false;
  } finally {
    if ((await disposeOwnedParent(parentOwned)) === 'failed') cleanupResult = 'failed';
    if ((await lifecycle.cleanup()) === 'failed') cleanupResult = 'failed';
  }

  // Honest classification: unavailable old ORM runtime → unverified, never fake pass.
  let status: AppRollbackEvidence['status'];
  if (!destructiveCommandsRejected || cleanupResult === 'failed') status = 'failed';
  else if (!baselineExecutable) status = 'unverified';
  else if (newTablesRetained && rollForwardOk) status = 'passed';
  else status = 'failed';

  const bits = [
    destructiveCommandsRejected,
    newTablesRetained,
    rollForwardOk,
    cleanupResult === 'passed',
    baselineExecutable,
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

  // Official layout: raw under raw/, envelope under envelopes/
  const rawDir = path.join(path.dirname(options.outputPath), 'raw');
  const envDir = path.join(path.dirname(options.outputPath), 'envelopes');
  const rawPath = path.join(rawDir, 'app-rollback.raw.json');
  const envelopePath = path.join(envDir, 'app-rollback.envelope.json');

  // Embedded rawReport must be byte-identical to the hashed raw file content.
  const rawReport = {
    ...evidence,
    baselineDetail,
  };
  const { sha256: artifactSha256 } = await writeJsonAtomic(rawPath, rawReport);
  const gateEvidence = toPreflightGateEvidence({
    artifactSha256,
    assertions: evidence.assertions,
    candidateSha: options.candidateSha,
    gate: 'app-rollback',
    generatedAt: nowIso,
    rawReport,
    releaseId: options.releaseId,
    scope: evidence.scope,
    status: evidence.status,
  });
  await writeJsonAtomic(envelopePath, gateEvidence);
  // Also write the requested outputPath as a pointer-style copy of the envelope for single-file use
  await writeJsonAtomic(options.outputPath, gateEvidence);

  return {
    baselineDetail,
    evidence,
    exitCode: status === 'passed' ? 0 : 1,
    gateEvidence,
  };
};

const seal = async (
  options: AppRollbackDrillOptions,
  nowIso: string,
  state: {
    baselineDetail: string;
    baselineExecutable: boolean;
    cleanupResult: 'failed' | 'passed';
    destructiveCommandsRejected: boolean;
    newTablesRetained: boolean;
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
  const { sha256 } = await writeJsonAtomic(options.outputPath, evidence).catch(() => ({
    sha256: createHash('sha256').update('').digest('hex'),
  }));
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
  return {
    baselineDetail: state.baselineDetail,
    evidence,
    exitCode: 1,
    gateEvidence,
  };
};
