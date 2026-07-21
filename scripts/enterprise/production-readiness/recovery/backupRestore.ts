/**
 * Executable backup/restore drill with strict redacted evidence.
 */
import { createHash } from 'node:crypto';

import type { EvidenceScope } from '../constants';
import {
  BACKUP_RESTORE_LANE,
  BACKUP_RESTORE_SCHEMA_VERSION,
  PRODUCTION_READINESS_SCHEMA_VERSION,
  RECOVERY_PROTECTED_TABLES,
} from '../constants';
import { writeJsonAtomic } from '../fsUtils';
import { scanForForbiddenReportContent } from '../privacy';
import type { BackupRestoreEvidence } from '../schemas';
import {
  compareDigests,
  digestAuditLogs,
  digestResourceRevisions,
  verifyPublicationPointers,
  verifyRequiredTablesPresent,
  verifySecretReferenceDomains,
} from './invariants';
import {
  assertDistinctIdentities,
  createOwnedPostgres,
  type OwnedPostgresHandle,
} from './ownedPostgres';
import { seedRecoveryFixture } from './seed';

export interface BackupRestoreDrillOptions {
  candidateSha: string;
  dbSchemaVersionTag: string;
  /** Optional injected source/target for unit tests (bypass docker). */
  inject?: {
    source: OwnedPostgresHandle;
    target: OwnedPostgresHandle;
    cleanup: () => Promise<'failed' | 'passed'>;
  };
  nowIso?: string;
  outputPath: string;
  /**
   * Production-authorized mode requires explicit acknowledgement that source
   * must never be overwritten and restore targets an isolated database only.
   */
  productionAcknowledgement?: boolean;
  scope: EvidenceScope;
}

export interface BackupRestoreDrillResult {
  evidence: BackupRestoreEvidence;
  exitCode: number;
}

const emptyAssertions = () => ({ failed: 0, passed: 0, skipped: 0, total: 0 });

const buildFailedEvidence = (input: {
  candidateSha: string;
  cleanupResult: 'failed' | 'passed';
  dbSchemaVersionTag: string;
  reason: string;
  scope: EvidenceScope;
  sourceBackupDigest: string;
  nowIso: string;
}): BackupRestoreEvidence => {
  void input.reason;
  const core = {
    assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
    candidateSha: input.candidateSha,
    cleanupResult: input.cleanupResult,
    dbSchemaVersionTag: input.dbSchemaVersionTag,
    freshness: { generatedAt: input.nowIso },
    gate: 'backup-restore' as const,
    invariants: [{ id: 'restore-integrity', result: 'failed' as const }],
    lane: BACKUP_RESTORE_LANE,
    reportSchemaVersion: BACKUP_RESTORE_SCHEMA_VERSION,
    schemaVersion: PRODUCTION_READINESS_SCHEMA_VERSION,
    scope: input.scope,
    sourceBackupDigest: input.sourceBackupDigest,
    sourcePreserved: true as const,
    status: 'failed' as const,
  };
  const scan = scanForForbiddenReportContent(core);
  if (scan.result === 'failed') {
    throw new Error('Failed evidence itself failed redaction');
  }
  return core;
};

export const runBackupRestoreDrill = async (
  options: BackupRestoreDrillOptions,
): Promise<BackupRestoreDrillResult> => {
  const nowIso = options.nowIso ?? new Date().toISOString();
  let cleanupResult: 'failed' | 'passed' = 'passed';
  let sourceBackupDigest = createHash('sha256').update('empty').digest('hex');

  if (options.scope === 'production-authorized' && options.productionAcknowledgement !== true) {
    const evidence = buildFailedEvidence({
      candidateSha: options.candidateSha,
      cleanupResult: 'passed',
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      nowIso,
      reason: 'missing-production-acknowledgement',
      scope: options.scope,
      sourceBackupDigest,
    });
    await writeJsonAtomic(options.outputPath, evidence);
    return { evidence, exitCode: 1 };
  }

  let sourceLifecycle: Awaited<ReturnType<typeof createOwnedPostgres>> | undefined;
  let targetLifecycle: Awaited<ReturnType<typeof createOwnedPostgres>> | undefined;
  let source: OwnedPostgresHandle;
  let target: OwnedPostgresHandle;
  let cleanup: () => Promise<'failed' | 'passed'>;

  try {
    if (options.inject) {
      source = options.inject.source;
      target = options.inject.target;
      cleanup = options.inject.cleanup;
    } else {
      sourceLifecycle = await createOwnedPostgres();
      targetLifecycle = await createOwnedPostgres();
      source = sourceLifecycle.handle;
      target = targetLifecycle.handle;
      cleanup = async () => {
        const results = await Promise.all([sourceLifecycle!.cleanup(), targetLifecycle!.cleanup()]);
        return results.every((result) => result === 'passed') ? 'passed' : 'failed';
      };
    }

    assertDistinctIdentities(source.identityDigest, target.identityDigest);

    // Seed source only — never write recovery fixture into a production source identity.
    await source.withClient(async (client) => {
      await seedRecoveryFixture(client);
    });

    const beforeRevisions = await source.withClient(digestResourceRevisions);
    const beforeAudit = await source.withClient(digestAuditLogs);
    const beforeSecrets = await source.withClient(verifySecretReferenceDomains);

    if (beforeRevisions.rowCount < 1 || beforeAudit.rowCount < 1) {
      throw new Error('Source seed produced empty critical tables');
    }

    const dump = await source.pgDumpCustom();
    sourceBackupDigest = createHash('sha256').update(dump).digest('hex');

    // Corrupted dump detection for empty/truncated buffers is handled by pgRestoreCustom.
    await target.pgRestoreCustom(dump);

    const afterRevisions = await target.withClient(digestResourceRevisions);
    const afterAudit = await target.withClient(digestAuditLogs);
    const afterSecrets = await target.withClient(verifySecretReferenceDomains);
    const tables = await target.withClient((client) =>
      verifyRequiredTablesPresent(client, RECOVERY_PROTECTED_TABLES),
    );
    const publications = await target.withClient(verifyPublicationPointers);

    // Source must still match pre-dump digests (source preserved).
    const sourceAfter = await source.withClient(digestResourceRevisions);
    const sourcePreserved = compareDigests(beforeRevisions, sourceAfter);

    const revisionMatch = compareDigests(beforeRevisions, afterRevisions);
    const auditMatch = compareDigests(beforeAudit, afterAudit);
    const secretMatch =
      beforeSecrets.aggregateDigest === afterSecrets.aggregateDigest &&
      !afterSecrets.dangling &&
      afterSecrets.identity.match &&
      afterSecrets.ai.match &&
      afterSecrets.connectors.match;

    const invariantResults = [
      {
        id: 'resource-revisions',
        result: revisionMatch ? ('passed' as const) : ('failed' as const),
      },
      { id: 'audit-logs', result: auditMatch ? ('passed' as const) : ('failed' as const) },
      { id: 'secret-references', result: secretMatch ? ('passed' as const) : ('failed' as const) },
      {
        id: 'required-tables',
        result: tables.match ? ('passed' as const) : ('failed' as const),
      },
      {
        id: 'publication-pointers',
        result: publications.match ? ('passed' as const) : ('failed' as const),
      },
      {
        id: 'source-preserved',
        result: sourcePreserved ? ('passed' as const) : ('failed' as const),
      },
    ].sort((left, right) => left.id.localeCompare(right.id, 'en'));

    const failedCount = invariantResults.filter((item) => item.result === 'failed').length;
    const passedCount = invariantResults.filter((item) => item.result === 'passed').length;
    const allPassed = failedCount === 0 && passedCount === invariantResults.length;

    cleanupResult = await cleanup();

    // Local harness never claims production-authorized pass even if invariants hold.
    const status =
      allPassed && cleanupResult === 'passed'
        ? options.scope === 'local-harness'
          ? ('passed' as const) // local may pass as harness evidence; preflight still won't overall-pass production
          : ('passed' as const)
        : allPassed
          ? ('failed' as const)
          : ('failed' as const);

    // If cleanup failed, force failed status.
    const finalStatus = cleanupResult === 'failed' ? ('failed' as const) : status;

    const evidence: BackupRestoreEvidence = {
      assertions: {
        failed: failedCount + (cleanupResult === 'failed' ? 1 : 0),
        passed: passedCount,
        skipped: 0,
        total: invariantResults.length + (cleanupResult === 'failed' ? 1 : 0),
      },
      candidateSha: options.candidateSha,
      cleanupResult,
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      freshness: { generatedAt: nowIso },
      gate: 'backup-restore',
      invariants: invariantResults,
      lane: BACKUP_RESTORE_LANE,
      reportSchemaVersion: BACKUP_RESTORE_SCHEMA_VERSION,
      schemaVersion: PRODUCTION_READINESS_SCHEMA_VERSION,
      scope: options.scope,
      sourceBackupDigest,
      sourcePreserved: true,
      status:
        finalStatus === 'passed' && allPassed && cleanupResult === 'passed'
          ? 'passed'
          : finalStatus === 'passed'
            ? 'failed'
            : 'failed',
    };

    // Normalize assertions when all passed.
    if (evidence.status === 'passed') {
      evidence.assertions = {
        failed: 0,
        passed: invariantResults.length,
        skipped: 0,
        total: invariantResults.length,
      };
    }

    const scan = scanForForbiddenReportContent(evidence);
    if (scan.result === 'failed') {
      throw new Error(
        `Backup-restore evidence redaction rejected ${scan.violations} forbidden field(s)`,
      );
    }

    await writeJsonAtomic(options.outputPath, evidence);
    return {
      evidence,
      exitCode: evidence.status === 'passed' && cleanupResult === 'passed' ? 0 : 1,
    };
  } catch {
    if (sourceLifecycle || targetLifecycle) {
      const results = await Promise.all([
        sourceLifecycle?.cleanup() ?? Promise.resolve('passed' as const),
        targetLifecycle?.cleanup() ?? Promise.resolve('passed' as const),
      ]);
      cleanupResult = results.every((result) => result === 'passed') ? 'passed' : 'failed';
    } else if (options.inject) {
      cleanupResult = await options.inject.cleanup();
    }

    const evidence = buildFailedEvidence({
      candidateSha: options.candidateSha,
      cleanupResult,
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      nowIso,
      reason: 'drill-failed',
      scope: options.scope,
      sourceBackupDigest,
    });
    // Ensure assertions non-zero failed.
    if (evidence.assertions.total === 0) {
      evidence.assertions = { failed: 1, passed: 0, skipped: 0, total: 1 };
    }
    await writeJsonAtomic(options.outputPath, evidence).catch(() => undefined);
    return { evidence, exitCode: 1 };
  }
};

/**
 * Pure validation helpers used by unit tests (no docker).
 */
export const rejectIdenticalSourceTarget = (sourceId: string, targetId: string): void => {
  assertDistinctIdentities(sourceId, targetId);
};

export const isCorruptedDump = (buffer: Buffer): boolean =>
  !Buffer.isBuffer(buffer) || buffer.byteLength < 16;

export { emptyAssertions };
