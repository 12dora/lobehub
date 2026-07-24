/**
 * Backup/restore drills with harness vs production split.
 * Production never seeds domain fixture into the restore target.
 *
 * Provenance roles (RR4):
 * - source-backup: signed over dump+manifest BEFORE restore (input)
 * - recovery-result: signed over raw report AFTER restore (gate envelope only)
 * Never attach input provenance as gate envelope provenance.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { EvidenceScope } from '../constants';
import {
  BACKUP_RESTORE_LANE,
  BACKUP_RESTORE_SCHEMA_VERSION,
  PRODUCTION_READINESS_SCHEMA_VERSION,
} from '../constants';
import { writeJsonAtomic } from '../fsUtils';
import { scanForForbiddenReportContent } from '../privacy';
import type { BackupRestoreEvidence } from '../schemas';
import {
  digestSignedProvenanceEnvelope,
  PRODUCTION_TRUST_POLICY,
  resolveAttestationRole,
  type SignedProvenanceEnvelope,
  type TrustPolicy,
  verifySignedProvenance,
} from '../trust';
import { toPreflightGateEvidence } from './evidenceEnvelope';
import {
  buildSourceManifestCore,
  compareDigests,
  compareTableDigests,
  digestAuditLogs,
  digestResourceRevisions,
  verifyPublicationPointers,
  verifyRequiredTablesPresent,
  verifySecretReferenceDomains,
} from './invariants';
import { assertDistinctIdentities, createOwnedPostgres } from './ownedPostgres';
import { seedRecoveryFixture } from './seed';

/** Non-secret classification of verified input attestation carried in raw report. */
export interface InputAttestationRef {
  dumpDigest: string;
  inputAttestationSha256: string;
  role: 'source-backup';
  sourceManifestSha256: string;
  verified: true;
}

export interface BackupRestoreDrillOptions {
  backupFile?: string;
  /** Signed source-backup provenance (dump digest). Never used as gate envelope provenance. */
  backupProvenance?: SignedProvenanceEnvelope | unknown;
  candidateSha: string;
  dbSchemaVersionTag: string;
  nowIso?: string;
  outputPath: string;
  releaseId?: string;
  /**
   * Optional recovery-result provenance signed over the raw report digest.
   * Only this may appear on the gate envelope for production preflight.
   */
  resultProvenance?: SignedProvenanceEnvelope | unknown;
  scope: 'ci-harness' | 'local-harness' | 'production-authorized';
  /** Source manifest JSON path (canonical before-state). Required for production. */
  sourceManifestPath?: string;
  trustPolicy?: TrustPolicy;
}

export interface BackupRestoreDrillResult {
  evidence: BackupRestoreEvidence & { inputAttestation?: InputAttestationRef };
  exitCode: number;
  gateEvidence: ReturnType<typeof toPreflightGateEvidence>;
  /** Digest of raw report (envelope artifactSha256). */
  rawReportSha256?: string;
}

const buildEvidence = (input: {
  assertions: BackupRestoreEvidence['assertions'];
  candidateSha: string;
  cleanupResult: 'failed' | 'passed';
  dbSchemaVersionTag: string;
  inputAttestation?: InputAttestationRef;
  invariants: BackupRestoreEvidence['invariants'];
  nowIso: string;
  scope: EvidenceScope;
  sourceBackupDigest: string;
  status: BackupRestoreEvidence['status'];
}): BackupRestoreEvidence & { inputAttestation?: InputAttestationRef } => {
  const evidence: BackupRestoreEvidence & { inputAttestation?: InputAttestationRef } = {
    assertions: input.assertions,
    candidateSha: input.candidateSha,
    cleanupResult: input.cleanupResult,
    dbSchemaVersionTag: input.dbSchemaVersionTag,
    freshness: { generatedAt: input.nowIso },
    gate: 'backup-restore',
    ...(input.inputAttestation ? { inputAttestation: input.inputAttestation } : {}),
    invariants: input.invariants,
    lane: BACKUP_RESTORE_LANE,
    reportSchemaVersion: BACKUP_RESTORE_SCHEMA_VERSION,
    schemaVersion: PRODUCTION_READINESS_SCHEMA_VERSION,
    scope: input.scope,
    sourceBackupDigest: input.sourceBackupDigest,
    sourcePreserved: true,
    status: input.status,
  };
  if (scanForForbiddenReportContent(evidence).result === 'failed') {
    throw new Error('Backup-restore evidence redaction rejected');
  }
  return evidence;
};

const writeResult = async (
  options: BackupRestoreDrillOptions,
  evidence: BackupRestoreEvidence & { inputAttestation?: InputAttestationRef },
  exitCode: number,
  /** Only recovery-result provenance may be attached to the gate envelope. */
  resultProvenance?: unknown,
): Promise<BackupRestoreDrillResult> => {
  const dir = path.dirname(options.outputPath);
  const base = path.basename(options.outputPath).replace(/\.json$/u, '');
  const rawPath = path.join(dir, 'raw', `${base}.raw.json`);
  const envelopePath = path.join(dir, 'envelopes', `backup-restore.envelope.json`);
  const { sha256 } = await writeJsonAtomic(rawPath, evidence);

  // Reject accidental attachment of source-backup provenance to the gate envelope.
  let safeResultProvenance: unknown;
  if (
    resultProvenance &&
    typeof resultProvenance === 'object' &&
    resultProvenance !== null &&
    'payload' in resultProvenance
  ) {
    const role = resolveAttestationRole((resultProvenance as SignedProvenanceEnvelope).payload);
    if (role !== 'source-backup') {
      safeResultProvenance = resultProvenance;
    }
  }

  const gateEvidence = toPreflightGateEvidence({
    artifactSha256: sha256,
    assertions: evidence.assertions,
    candidateSha: evidence.candidateSha,
    gate: 'backup-restore',
    generatedAt: evidence.freshness.generatedAt,
    provenance: safeResultProvenance,
    rawReport: evidence,
    releaseId: options.releaseId,
    scope: evidence.scope,
    status: evidence.status,
  });
  await writeJsonAtomic(envelopePath, gateEvidence);
  await writeJsonAtomic(options.outputPath, gateEvidence);
  return { evidence, exitCode, gateEvidence, rawReportSha256: sha256 };
};

/**
 * Attach an externally signed recovery-result provenance to an existing evidence dir.
 * Verifies role + artifact match before writing. No private keys in production runtime.
 */
export const finalizeBackupRestoreResultProvenance = async (input: {
  envelopePath: string;
  rawReportPath: string;
  resultProvenance: SignedProvenanceEnvelope | unknown;
  trustPolicy?: TrustPolicy;
  candidateSha: string;
  releaseId?: string;
}): Promise<{ ok: true; artifactSha256: string } | { ok: false; reason: string }> => {
  const rawText = await readFile(input.rawReportPath, 'utf8');
  const artifactSha256 = createHash('sha256').update(rawText).digest('hex');
  const raw = JSON.parse(rawText) as {
    inputAttestation?: InputAttestationRef;
    status?: string;
  };
  const verdict = verifySignedProvenance(input.resultProvenance, {
    expectedArtifactSha256: artifactSha256,
    expectedAttestationRole: 'recovery-result',
    expectedCandidateSha: input.candidateSha,
    expectedGateId: 'backup-restore',
    expectedInputAttestationSha256: raw.inputAttestation?.inputAttestationSha256,
    expectedReleaseId: input.releaseId,
    policy: input.trustPolicy ?? PRODUCTION_TRUST_POLICY,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const envelope = JSON.parse(await readFile(input.envelopePath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (envelope.artifactSha256 !== artifactSha256) {
    return { ok: false, reason: 'envelope-raw-digest-mismatch' };
  }
  envelope.provenance = input.resultProvenance;
  await writeJsonAtomic(input.envelopePath, envelope);
  return { ok: true, artifactSha256 };
};

export const runBackupRestoreDrill = async (
  options: BackupRestoreDrillOptions,
): Promise<BackupRestoreDrillResult> => {
  const nowIso = options.nowIso ?? new Date().toISOString();
  if (options.scope === 'production-authorized') {
    return runProductionBackupRestore(options, nowIso);
  }
  return runHarnessBackupRestore(options, nowIso);
};

const runHarnessBackupRestore = async (
  options: BackupRestoreDrillOptions,
  nowIso: string,
): Promise<BackupRestoreDrillResult> => {
  const harnessScope: 'ci-harness' | 'local-harness' =
    options.scope === 'ci-harness' ? 'ci-harness' : 'local-harness';
  let cleanupResult: 'failed' | 'passed' = 'passed';
  let sourceBackupDigest = createHash('sha256').update('empty').digest('hex');
  let sourceLifecycle: Awaited<ReturnType<typeof createOwnedPostgres>> | undefined;
  let targetLifecycle: Awaited<ReturnType<typeof createOwnedPostgres>> | undefined;

  try {
    sourceLifecycle = await createOwnedPostgres();
    targetLifecycle = await createOwnedPostgres();
    const source = sourceLifecycle.handle;
    const target = targetLifecycle.handle;
    assertDistinctIdentities(source.identityDigest, target.identityDigest);

    await source.withClient(async (client) => {
      await seedRecoveryFixture(client);
    });

    const before = await source.withClient(async (client) => buildSourceManifestCore(client));
    const dump = await source.pgDumpCustom();
    sourceBackupDigest = createHash('sha256').update(dump).digest('hex');
    await target.pgRestoreCustom(dump);

    const after = await target.withClient(async (client) => buildSourceManifestCore(client));
    const sourceAfter = await source.withClient(async (client) => buildSourceManifestCore(client));

    const invariants = [
      {
        id: 'resource-revisions',
        result:
          before.revisions.digest === after.revisions.digest &&
          before.revisions.rowCount === after.revisions.rowCount
            ? ('passed' as const)
            : ('failed' as const),
      },
      {
        id: 'audit-logs',
        result:
          before.audits.digest === after.audits.digest &&
          before.audits.rowCount === after.audits.rowCount
            ? ('passed' as const)
            : ('failed' as const),
      },
      {
        id: 'secret-references',
        result:
          before.secrets.aggregateDigest === after.secrets.aggregateDigest && after.secrets.match
            ? ('passed' as const)
            : ('failed' as const),
      },
      {
        id: 'required-tables',
        result: compareTableDigests(before.tables, after.tables)
          ? ('passed' as const)
          : ('failed' as const),
      },
      {
        id: 'publication-pointers',
        result:
          before.pointerDigest === after.pointerDigest &&
          before.publishedCount === after.publishedCount
            ? ('passed' as const)
            : ('failed' as const),
      },
      {
        id: 'source-preserved',
        result:
          before.revisions.digest === sourceAfter.revisions.digest
            ? ('passed' as const)
            : ('failed' as const),
      },
    ].sort((a, b) => a.id.localeCompare(b.id, 'en'));

    cleanupResult = (
      await Promise.all([sourceLifecycle.cleanup(), targetLifecycle.cleanup()])
    ).every((r) => r === 'passed')
      ? 'passed'
      : 'failed';

    const failedCount = invariants.filter((i) => i.result === 'failed').length;
    const allPassed = failedCount === 0 && cleanupResult === 'passed';
    const evidence = buildEvidence({
      assertions: allPassed
        ? { failed: 0, passed: invariants.length, skipped: 0, total: invariants.length }
        : {
            failed: failedCount + (cleanupResult === 'failed' ? 1 : 0),
            passed: invariants.length - failedCount,
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
    return writeResult(options, evidence, allPassed ? 0 : 1);
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
    return writeResult(options, evidence, 1);
  }
};

/**
 * Production: empty owned target, external archive + signed provenance + source manifest.
 * Never seeds domain fixture into the restore target.
 */
const runProductionBackupRestore = async (
  options: BackupRestoreDrillOptions,
  nowIso: string,
): Promise<BackupRestoreDrillResult> => {
  const policy = options.trustPolicy ?? PRODUCTION_TRUST_POLICY;
  const emptyDigest = createHash('sha256').update('empty').digest('hex');

  if (!options.backupFile || !options.backupProvenance || !options.sourceManifestPath) {
    const evidence = buildEvidence({
      assertions: { failed: 0, passed: 0, skipped: 1, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult: 'passed',
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      scope: 'local-harness',
      sourceBackupDigest: emptyDigest,
      status: 'unverified',
    });
    return writeResult(options, evidence, 1);
  }

  let backupAbs: string;
  try {
    const st = await lstat(options.backupFile);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('backup-not-regular-file');
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
    return writeResult(options, evidence, 1);
  }

  /** Stream dump through SHA-256 (no full-file buffer for hashing). */
  const hashFileSha256 = async (filePath: string): Promise<string> => {
    const hash = createHash('sha256');
    await pipeline(createReadStream(filePath), hash);
    return hash.digest('hex');
  };

  /** Stream dump into a Buffer for pg_restore (chunked read; no double full-file materialization for digest). */
  const readFileChunked = async (filePath: string): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('data', (chunk: string | Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => resolve());
    });
    return Buffer.concat(chunks);
  };

  const sourceBackupDigest = await hashFileSha256(backupAbs);

  // Manifest must be a regular file (reject symlink/path swaps as far as ownership allows).
  let manifestAbs: string;
  try {
    const mst = await lstat(options.sourceManifestPath);
    if (mst.isSymbolicLink() || !mst.isFile()) throw new Error('manifest-not-regular-file');
    manifestAbs = await realpath(options.sourceManifestPath);
  } catch {
    const evidence = buildEvidence({
      assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult: 'passed',
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      scope: 'local-harness',
      sourceBackupDigest,
      status: 'failed',
    });
    return writeResult(options, evidence, 1);
  }

  const manifestRaw = await readFile(manifestAbs, 'utf8');
  const sourceManifestSha256 = createHash('sha256').update(manifestRaw).digest('hex');
  let manifest: {
    audits: { digest: string; rowCount: number };
    inventoryVersion?: number;
    manifestSchemaVersion?: number;
    pointerDigest: string;
    publishedCount: number;
    revisions: { digest: string; rowCount: number };
    secrets: { aggregateDigest: string };
    tables: Array<{ digest: string; name: string; rowCount: number }>;
  };
  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest;
    if (
      typeof manifest.revisions?.digest !== 'string' ||
      typeof manifest.audits?.digest !== 'string' ||
      !Array.isArray(manifest.tables)
    ) {
      throw new Error('manifest-shape-invalid');
    }
  } catch {
    const evidence = buildEvidence({
      assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult: 'passed',
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      scope: 'local-harness',
      sourceBackupDigest,
      status: 'failed',
    });
    return writeResult(options, evidence, 1);
  }

  // Re-hash dump after manifest to reduce TOCTOU window; digests must still match.
  const dumpDigestAgain = await hashFileSha256(backupAbs);
  if (dumpDigestAgain !== sourceBackupDigest) {
    const evidence = buildEvidence({
      assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult: 'passed',
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      scope: 'local-harness',
      sourceBackupDigest,
      status: 'failed',
    });
    return writeResult(options, evidence, 1);
  }

  // Load dump bytes once (chunked) for restore after digest checks.
  const dump = await readFileChunked(backupAbs);

  const inputVerdict = verifySignedProvenance(options.backupProvenance, {
    expectedArtifactSha256: sourceBackupDigest,
    expectedAttestationRole: 'source-backup',
    expectedBackupBinding: {
      inventoryVersion: 1,
      manifestSchemaVersion: 1,
      sourceDbToolVersion: 'pg_dump-16',
      sourceManifestSha256,
      sourceSchemaTag: options.dbSchemaVersionTag,
    },
    expectedCandidateSha: options.candidateSha,
    expectedGateId: 'backup-restore',
    expectedReleaseId: options.releaseId,
    expectedSourceManifestSha256: sourceManifestSha256,
    policy,
  });
  if (!inputVerdict.ok || inputVerdict.environment !== 'production') {
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
    // Never attach input provenance to gate envelope.
    return writeResult(options, evidence, 1);
  }

  const inputAttestation: InputAttestationRef = {
    dumpDigest: sourceBackupDigest,
    inputAttestationSha256: digestSignedProvenanceEnvelope(
      options.backupProvenance as SignedProvenanceEnvelope,
    ),
    role: 'source-backup',
    sourceManifestSha256,
    verified: true,
  };

  // Empty owned target — NO seedRecoveryFixture.
  let targetLifecycle: Awaited<ReturnType<typeof createOwnedPostgres>> | undefined;
  let cleanupResult: 'failed' | 'passed' = 'passed';
  try {
    targetLifecycle = await createOwnedPostgres();
    const target = targetLifecycle.handle;
    // Empty database: only public schema from postgres image.
    await target.pgRestoreCustom(dump);

    const after = await target.withClient(async (client) => buildSourceManifestCore(client));

    const invariants = [
      {
        id: 'resource-revisions',
        result:
          after.revisions.digest === manifest.revisions.digest &&
          after.revisions.rowCount === manifest.revisions.rowCount
            ? ('passed' as const)
            : ('failed' as const),
      },
      {
        id: 'audit-logs',
        result:
          after.audits.digest === manifest.audits.digest &&
          after.audits.rowCount === manifest.audits.rowCount
            ? ('passed' as const)
            : ('failed' as const),
      },
      {
        id: 'secret-references',
        result:
          after.secrets.aggregateDigest === manifest.secrets.aggregateDigest && after.secrets.match
            ? ('passed' as const)
            : ('failed' as const),
      },
      {
        id: 'required-tables',
        result: compareTableDigests(manifest.tables, after.tables)
          ? ('passed' as const)
          : ('failed' as const),
      },
      {
        id: 'publication-pointers',
        result:
          after.pointerDigest === manifest.pointerDigest &&
          after.publishedCount === manifest.publishedCount
            ? ('passed' as const)
            : ('failed' as const),
      },
      { id: 'source-preserved', result: 'passed' as const },
    ].sort((a, b) => a.id.localeCompare(b.id, 'en'));

    cleanupResult = await targetLifecycle.cleanup();
    const failed = invariants.filter((i) => i.result === 'failed').length;
    const allPassed = failed === 0 && cleanupResult === 'passed';
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
      inputAttestation,
      invariants,
      nowIso,
      // Input verified; without recovery-result signature, envelope stays local/unverified for production pass.
      scope: 'local-harness',
      sourceBackupDigest,
      status: allPassed ? 'passed' : 'failed',
    });
    // Only optional recovery-result provenance goes on the envelope — never source-backup.
    return writeResult(options, evidence, allPassed ? 0 : 1, options.resultProvenance);
  } catch {
    if (targetLifecycle) cleanupResult = await targetLifecycle.cleanup();
    const evidence = buildEvidence({
      assertions: { failed: 1, passed: 0, skipped: 0, total: 1 },
      candidateSha: options.candidateSha,
      cleanupResult,
      dbSchemaVersionTag: options.dbSchemaVersionTag,
      inputAttestation,
      invariants: [{ id: 'restore-integrity', result: 'failed' }],
      nowIso,
      scope: 'local-harness',
      sourceBackupDigest,
      status: 'failed',
    });
    return writeResult(options, evidence, 1);
  }
};

export const rejectIdenticalSourceTarget = (a: string, b: string): void => {
  assertDistinctIdentities(a, b);
};

export const isCorruptedDump = (buffer: Buffer): boolean =>
  !Buffer.isBuffer(buffer) || buffer.byteLength < 16;

export {
  buildSourceManifestCore,
  compareDigests,
  digestAuditLogs,
  digestResourceRevisions,
  verifyPublicationPointers,
  verifyRequiredTablesPresent,
  verifySecretReferenceDomains,
};
