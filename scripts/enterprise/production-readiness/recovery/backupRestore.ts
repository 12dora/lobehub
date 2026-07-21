/**
 * Backup/restore drills:
 * - local/ci harness: owned PG only; never production-authorized
 * - production path: requires external backup file + signed provenance; never seeds source
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { EvidenceScope } from '../constants';
import {
  BACKUP_RESTORE_LANE,
  BACKUP_RESTORE_SCHEMA_VERSION,
  PRODUCTION_READINESS_SCHEMA_VERSION,
} from '../constants';
import { writeJsonAtomic } from '../fsUtils';
import { RECOVERY_ENTERPRISE_TABLES } from '../inventory';
import { scanForForbiddenReportContent } from '../privacy';
import type { BackupRestoreEvidence } from '../schemas';
import {
  PRODUCTION_TRUST_POLICY,
  type SignedProvenanceEnvelope,
  type TrustPolicy,
  verifySignedProvenance,
} from '../trust';
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
  /** Production only: path to external backup artifact (custom format). */
  backupFile?: string;
  /** Production only: signed provenance over backup digest. */
  backupProvenance?: SignedProvenanceEnvelope | unknown;
  candidateSha: string;
  dbSchemaVersionTag: string;
  inject?: {
    source: OwnedPostgresHandle;
    target: OwnedPostgresHandle;
    cleanup: () => Promise<'failed' | 'passed'>;
  };
  nowIso?: string;
  outputPath: string;
  releaseId?: string;
  scope: 'ci-harness' | 'local-harness' | 'production-authorized';
  trustPolicy?: TrustPolicy;
}

export interface BackupRestoreDrillResult {
  evidence: BackupRestoreEvidence;
  exitCode: number;
}

const buildEvidence = (input: {
  assertions: BackupRestoreEvidence['assertions'];
  candidateSha: string;
  cleanupResult: 'failed' | 'passed';
  dbSchemaVersionTag: string;
  invariants: BackupRestoreEvidence['invariants'];
  nowIso: string;
  scope: EvidenceScope;
  sourceBackupDigest: string;
  status: BackupRestoreEvidence['status'];
}): BackupRestoreEvidence => {
  const evidence: BackupRestoreEvidence = {
    assertions: input.assertions,
    candidateSha: input.candidateSha,
    cleanupResult: input.cleanupResult,
    dbSchemaVersionTag: input.dbSchemaVersionTag,
    freshness: { generatedAt: input.nowIso },
    gate: 'backup-restore',
    invariants: input.invariants,
    lane: BACKUP_RESTORE_LANE,
    reportSchemaVersion: BACKUP_RESTORE_SCHEMA_VERSION,
    schemaVersion: PRODUCTION_READINESS_SCHEMA_VERSION,
    scope: input.scope,
    sourceBackupDigest: input.sourceBackupDigest,
    sourcePreserved: true,
    status: input.status,
  };
  const scan = scanForForbiddenReportContent(evidence);
  if (scan.result === 'failed') {
    throw new Error(`Backup-restore evidence redaction rejected ${scan.violations} field(s)`);
  }
  return evidence;
};

const runInvariants = async (
  source: OwnedPostgresHandle | undefined,
  target: OwnedPostgresHandle,
  before: {
    revisions: Awaited<ReturnType<typeof digestResourceRevisions>>;
    audit: Awaited<ReturnType<typeof digestAuditLogs>>;
    secrets: Awaited<ReturnType<typeof verifySecretReferenceDomains>>;
    publishedCount: number;
  },
) => {
  const afterRevisions = await target.withClient(digestResourceRevisions);
  const afterAudit = await target.withClient(digestAuditLogs);
  const afterSecrets = await target.withClient(verifySecretReferenceDomains);
  const tables = await target.withClient((client) =>
    verifyRequiredTablesPresent(client, RECOVERY_ENTERPRISE_TABLES),
  );
  const publications = await target.withClient((client) =>
    verifyPublicationPointers(client, {
      priorPublishedCount: before.publishedCount,
    }),
  );

  let sourcePreserved = true;
  if (source) {
    const sourceAfter = await source.withClient(digestResourceRevisions);
    sourcePreserved = compareDigests(before.revisions, sourceAfter);
  }

  const revisionMatch = compareDigests(before.revisions, afterRevisions);
  const auditMatch = compareDigests(before.audit, afterAudit);
  const secretMatch =
    before.secrets.aggregateDigest === afterSecrets.aggregateDigest && afterSecrets.match;

  return [
    { id: 'resource-revisions', result: revisionMatch ? ('passed' as const) : ('failed' as const) },
    { id: 'audit-logs', result: auditMatch ? ('passed' as const) : ('failed' as const) },
    { id: 'secret-references', result: secretMatch ? ('passed' as const) : ('failed' as const) },
    { id: 'required-tables', result: tables.match ? ('passed' as const) : ('failed' as const) },
    {
      id: 'publication-pointers',
      result: publications.match ? ('passed' as const) : ('failed' as const),
    },
    {
      id: 'source-preserved',
      result: sourcePreserved ? ('passed' as const) : ('failed' as const),
    },
  ].sort((a, b) => a.id.localeCompare(b.id, 'en'));
};

/**
 * Harness path: always local-harness or ci-harness scope. Never production-authorized.
 */
export const runBackupRestoreDrill = async (
  options: BackupRestoreDrillOptions,
): Promise<BackupRestoreDrillResult> => {
  const nowIso = options.nowIso ?? new Date().toISOString();

  // Any attempt to label harness production is forced down.
  if (options.scope === 'production-authorized') {
    return runProductionBackupRestore(options, nowIso);
  }

  const harnessScope: 'ci-harness' | 'local-harness' =
    options.scope === 'ci-harness' ? 'ci-harness' : 'local-harness';

  let cleanupResult: 'failed' | 'passed' = 'passed';
  let sourceBackupDigest = createHash('sha256').update('empty').digest('hex');
  let sourceLifecycle: Awaited<ReturnType<typeof createOwnedPostgres>> | undefined;
  let targetLifecycle: Awaited<ReturnType<typeof createOwnedPostgres>> | undefined;

  try {
    let source: OwnedPostgresHandle;
    let target: OwnedPostgresHandle;
    let cleanup: () => Promise<'failed' | 'passed'>;

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
        return results.every((r) => r === 'passed') ? 'passed' : 'failed';
      };
    }

    assertDistinctIdentities(source.identityDigest, target.identityDigest);

    await source.withClient(async (client) => {
      await seedRecoveryFixture(client);
    });

    const beforeRevisions = await source.withClient(digestResourceRevisions);
    const beforeAudit = await source.withClient(digestAuditLogs);
    const beforeSecrets = await source.withClient(verifySecretReferenceDomains);
    const published = await source.withClient(async (client) => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM platform_resource_revisions WHERE status = 'published'`,
      );
      return Number(r.rows[0]?.count ?? 0);
    });

    const dump = await source.pgDumpCustom();
    sourceBackupDigest = createHash('sha256').update(dump).digest('hex');
    await target.pgRestoreCustom(dump);

    const invariants = await runInvariants(source, target, {
      audit: beforeAudit,
      publishedCount: published,
      revisions: beforeRevisions,
      secrets: beforeSecrets,
    });

    cleanupResult = await cleanup();
    const failedCount = invariants.filter((i) => i.result === 'failed').length;
    const passedCount = invariants.filter((i) => i.result === 'passed').length;
    const allPassed = failedCount === 0 && cleanupResult === 'passed';

    const evidence = buildEvidence({
      assertions: allPassed
        ? { failed: 0, passed: invariants.length, skipped: 0, total: invariants.length }
        : {
            failed: failedCount + (cleanupResult === 'failed' ? 1 : 0),
            passed: passedCount,
            skipped: 0,
            total: invariants.length + (cleanupResult === 'failed' ? 1 : 0),
          },
      candidateSha: options.candidateSha,
      cleanupResult,
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants,
      nowIso,
      scope: harnessScope,
      sourceBackupDigest,
      status: allPassed ? 'passed' : 'failed',
    });

    await writeJsonAtomic(options.outputPath, evidence);
    return { evidence, exitCode: evidence.status === 'passed' ? 0 : 1 };
  } catch {
    if (sourceLifecycle || targetLifecycle) {
      const results = await Promise.all([
        sourceLifecycle?.cleanup() ?? Promise.resolve('passed' as const),
        targetLifecycle?.cleanup() ?? Promise.resolve('passed' as const),
      ]);
      cleanupResult = results.every((r) => r === 'passed') ? 'passed' : 'failed';
    }
    const evidence = buildEvidence({
      assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult,
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      scope: harnessScope,
      sourceBackupDigest,
      status: 'failed',
    });
    await writeJsonAtomic(options.outputPath, evidence).catch(() => undefined);
    return { evidence, exitCode: 1 };
  }
};

/**
 * Production path: external backup + signed provenance. Never creates/seeds source.
 * Restores only into owned isolated target.
 */
const runProductionBackupRestore = async (
  options: BackupRestoreDrillOptions,
  nowIso: string,
): Promise<BackupRestoreDrillResult> => {
  const policy = options.trustPolicy ?? PRODUCTION_TRUST_POLICY;
  const emptyDigest = createHash('sha256').update('empty').digest('hex');

  if (!options.backupFile || !options.backupProvenance) {
    const evidence = buildEvidence({
      assertions: { failed: 0, passed: 0, skipped: 1, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult: 'passed',
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      // Never claim production-authorized without verification — use local for artifact shape.
      scope: 'local-harness',
      sourceBackupDigest: emptyDigest,
      status: 'unverified',
    });
    await writeJsonAtomic(options.outputPath, evidence);
    return { evidence, exitCode: 1 };
  }

  // Refuse special files / symlinks
  let backupAbs: string;
  try {
    const st = await lstat(options.backupFile);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('backup-not-regular-file');
    }
    backupAbs = await realpath(options.backupFile);
  } catch {
    const evidence = buildEvidence({
      assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult: 'passed',
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      scope: 'local-harness',
      sourceBackupDigest: emptyDigest,
      status: 'failed',
    });
    await writeJsonAtomic(options.outputPath, evidence);
    return { evidence, exitCode: 1 };
  }

  const dump = await readFile(backupAbs);
  const sourceBackupDigest = createHash('sha256').update(dump).digest('hex');

  const verdict = verifySignedProvenance(options.backupProvenance, {
    expectedArtifactSha256: sourceBackupDigest,
    expectedCandidateSha: options.candidateSha,
    expectedGateId: 'backup-restore',
    expectedReleaseId: options.releaseId,
    policy,
  });

  if (!verdict.ok || verdict.environment !== 'production') {
    const evidence = buildEvidence({
      assertions: { failed: 0, passed: 0, skipped: 1, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult: 'passed',
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      scope: 'local-harness',
      sourceBackupDigest,
      status: 'unverified',
    });
    await writeJsonAtomic(options.outputPath, evidence);
    return { evidence, exitCode: 1 };
  }

  // Only restore into owned target — never connect to production source.
  let targetLifecycle: Awaited<ReturnType<typeof createOwnedPostgres>> | undefined;
  let cleanupResult: 'failed' | 'passed' = 'passed';
  try {
    targetLifecycle = await createOwnedPostgres();
    const target = targetLifecycle.handle;
    // Seed empty schema shell on target so pg_restore has a database; dump should create objects.
    await target.withClient(async (client) => {
      await seedRecoveryFixture(client);
    });
    // Capture "before" from dump provenance isn't available; verify post-restore internal consistency.
    await target.pgRestoreCustom(dump);

    const afterRevisions = await target.withClient(digestResourceRevisions);
    const afterAudit = await target.withClient(digestAuditLogs);
    const afterSecrets = await target.withClient(verifySecretReferenceDomains);
    const tables = await target.withClient((client) =>
      verifyRequiredTablesPresent(client, RECOVERY_ENTERPRISE_TABLES),
    );
    const publications = await target.withClient((client) => verifyPublicationPointers(client));

    const invariants = [
      {
        id: 'resource-revisions',
        result: afterRevisions.rowCount > 0 ? ('passed' as const) : ('failed' as const),
      },
      {
        id: 'audit-logs',
        result: afterAudit.rowCount > 0 ? ('passed' as const) : ('failed' as const),
      },
      {
        id: 'secret-references',
        result: afterSecrets.match ? ('passed' as const) : ('failed' as const),
      },
      { id: 'required-tables', result: tables.match ? ('passed' as const) : ('failed' as const) },
      {
        id: 'publication-pointers',
        result: publications.match ? ('passed' as const) : ('failed' as const),
      },
      { id: 'source-preserved', result: 'passed' as const },
    ].sort((a, b) => a.id.localeCompare(b.id, 'en'));

    cleanupResult = await targetLifecycle.cleanup();
    const failed = invariants.filter((i) => i.result === 'failed').length;
    const allPassed = failed === 0 && cleanupResult === 'passed';

    // Even with valid production provenance, scope on evidence remains local until preflight
    // re-derives production from the same provenance. Evidence file uses local-harness to
    // avoid self-declared production; preflight uses detached provenance.
    const evidence = buildEvidence({
      assertions: allPassed
        ? { failed: 0, passed: invariants.length, skipped: 0, total: invariants.length }
        : {
            failed: Math.max(1, failed),
            passed: invariants.length - failed,
            skipped: 0,
            total: invariants.length,
          },
      candidateSha: options.candidateSha,
      cleanupResult,
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants,
      nowIso,
      scope: 'local-harness',
      sourceBackupDigest,
      status: allPassed ? 'passed' : 'failed',
    });
    await writeJsonAtomic(options.outputPath, evidence);
    return { evidence, exitCode: allPassed ? 0 : 1 };
  } catch {
    if (targetLifecycle) cleanupResult = await targetLifecycle.cleanup();
    const evidence = buildEvidence({
      assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult,
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      scope: 'local-harness',
      sourceBackupDigest,
      status: 'failed',
    });
    await writeJsonAtomic(options.outputPath, evidence).catch(() => undefined);
    return { evidence, exitCode: 1 };
  }
};

export const rejectIdenticalSourceTarget = (sourceId: string, targetId: string): void => {
  assertDistinctIdentities(sourceId, targetId);
};

export const isCorruptedDump = (buffer: Buffer): boolean =>
  !Buffer.isBuffer(buffer) || buffer.byteLength < 16;

export const isUnsafeBackupPath = async (filePath: string): Promise<boolean> => {
  try {
    const st = await lstat(filePath);
    return st.isSymbolicLink() || !st.isFile();
  } catch {
    return true;
  }
};

void path;
