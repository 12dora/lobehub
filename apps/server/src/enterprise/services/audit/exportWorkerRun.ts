/** Fenced publication pipeline for a bound audit export attempt. */

import { createReadStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  PlatformAuditExportFilterSnapshot,
  PlatformAuditExportItem,
  PlatformAuditExportModel,
  PlatformJobModel,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import { AUDIT_EXPORT_ARTIFACT_VERSION } from './exportConstants';
import type { AuditExportArtifactStorage } from './exportStorage';
import { AUDIT_EXPORT_CONTENT_TYPE, formatArtifactChecksum } from './exportStorage';
import type { ProcessNextAuditExportOptions, ProcessNextAuditExportResult } from './exportWorker';
import { createArtifactWriter } from './exportWorkerArtifactWriter';
import { AuditExportLeaseLostError } from './exportWorkerErrors';
import { verifyUploadedArtifact } from './exportWorkerIntegrity';
import { createExportCancelGuard } from './exportWorkerLease';
import type { ExportTimeWindow } from './exportWorkerShared';
import { jsonlLine, runWithPeriodicLeaseMaintenance, toIso } from './exportWorkerShared';
import { materializeExportSnapshot, streamStagingIntoArtifact } from './exportWorkerSnapshot';
import { safeDeleteOwned, terminalCompleteExport } from './exportWorkerTerminal';

export const runFencedExportPublication = async (params: {
  afterArtifactUpload?: ProcessNextAuditExportOptions['afterArtifactUpload'];
  afterDomainComplete?: ProcessNextAuditExportOptions['afterDomainComplete'];
  attemptToken: string;
  createArtifactWriteStream?: ProcessNextAuditExportOptions['createArtifactWriteStream'];
  db: LobeChatDatabase;
  exportArtifactRetentionDays: number;
  exportId: string;
  exportRow: PlatformAuditExportItem;
  exportsModel: PlatformAuditExportModel;
  filter: PlatformAuditExportFilterSnapshot;
  jobId: string;
  jobs: PlatformJobModel;
  leaseMs: number;
  livePolicyRevision: number;
  maxArtifactBytes: number;
  maxExportRows: number;
  onSnapshotModelCall?: ProcessNextAuditExportOptions['onSnapshotModelCall'];
  onSnapshotPageFetch?: ProcessNextAuditExportOptions['onSnapshotPageFetch'];
  snapshotAt: Date;
  snapshotWindow: ExportTimeWindow;
  storage: AuditExportArtifactStorage;
  storageKey: string;
  workerId: string;
}): Promise<ProcessNextAuditExportResult> => {
  const {
    afterArtifactUpload,
    afterDomainComplete,
    attemptToken,
    createArtifactWriteStream,
    db,
    exportArtifactRetentionDays,
    exportId,
    exportRow,
    exportsModel,
    filter,
    jobId,
    jobs,
    leaseMs,
    livePolicyRevision,
    maxArtifactBytes,
    maxExportRows,
    onSnapshotModelCall,
    onSnapshotPageFetch,
    snapshotAt,
    snapshotWindow,
    storage,
    storageKey,
    workerId,
  } = params;

  // Stream NDJSON to a temp file (bounded memory: one line / batch, not 1M rows).
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'audit-export-'));
  const tmpPath = path.join(tmpDir, 'evidence.ndjson');
  const stagingPath = path.join(tmpDir, 'snapshot.ndjson');
  const artifact = createArtifactWriter({
    createArtifactWriteStream,
    maxArtifactBytes,
    tmpPath,
  });

  const assertNotCancelled = createExportCancelGuard({
    artifact,
    attemptToken,
    exportId,
    exportsModel,
    jobId,
    jobs,
    leaseMs,
    workerId,
  });

  let completedRow: Awaited<ReturnType<PlatformAuditExportModel['complete']>> | null;
  const requestedBy = exportRow.requestedBy;

  try {
    await assertNotCancelled();

    await artifact.writeLine(
      jsonlLine({
        createdAt: toIso(exportRow.createdAt),
        exportArtifactRetentionDays,
        exportId,
        filterSnapshot: filter,
        includesMessageBodies: exportRow.includesMessageBodies,
        kind: exportRow.kind,
        maxExportRows,
        policyRevision: filter.policyRevision ?? livePolicyRevision,
        snapshotAt: toIso(snapshotAt),
        type: 'manifest',
        version: AUDIT_EXPORT_ARTIFACT_VERSION,
      }),
    );

    // Phase 1: materialise immutable evidence under one RR snapshot. The lease
    // maintainer uses the outer pool while the snapshot transaction owns another
    // connection, preventing a long scan from becoming reclaimable.
    const snapshot = await runWithPeriodicLeaseMaintenance(
      () =>
        materializeExportSnapshot(db, {
          filter,
          includeBodies: exportRow.includesMessageBodies,
          kind: exportRow.kind,
          maxExportRows,
          maxStagingBytes: Math.max(0, maxArtifactBytes - artifact.totalBytes),
          onModelCall: onSnapshotModelCall,
          onPageFetch: onSnapshotPageFetch,
          stagingPath,
          window: snapshotWindow,
        }),
      assertNotCancelled,
      Math.max(1, Math.floor(leaseMs / 3)),
    );
    const evidenceCount = snapshot.evidenceCount;

    await assertNotCancelled();

    // Phase 2: stream frozen staging lines into the artifact with heartbeats
    // and batched copy (SAO-005 — no live N+1 re-reads).
    await streamStagingIntoArtifact(stagingPath, artifact.writeLine, assertNotCancelled);

    await assertNotCancelled();
    await artifact.end();

    // Incremental digest from the write path — never re-buffer the temp file (F10).
    const localChecksum = formatArtifactChecksum(artifact.digestHex());

    // Renew lease before long remote I/O (upload / metadata / hash) — SAO-002.
    await assertNotCancelled();

    // F6: durable cleanup intent for THIS attempt key only, fenced by attemptToken.
    const intentOk = await exportsModel.recordArtifactUploadIntent(exportId, storageKey, db, {
      attemptToken,
    });
    if (!intentOk) {
      throw new AuditExportLeaseLostError();
    }

    await assertNotCancelled();
    const uploaded = await storage.uploadArtifact({
      artifactChecksum: localChecksum,
      body: createReadStream(tmpPath),
      contentLength: artifact.totalBytes,
      contentType: AUDIT_EXPORT_CONTENT_TYPE,
      storageKey,
    });
    await assertNotCancelled();

    await verifyUploadedArtifact({
      assertNotCancelled,
      localChecksum,
      storage,
      storageKey,
      totalBytes: artifact.totalBytes,
      uploaded,
    });

    if (afterArtifactUpload) {
      await afterArtifactUpload({
        exportId,
        jobId,
        storageKey: uploaded.storageKey,
      });
    }

    await assertNotCancelled();

    const expiresAt = new Date(
      Date.now() + Math.max(1, exportArtifactRetentionDays) * 24 * 60 * 60 * 1000,
    );

    // Fenced transactional publication + required audit (SAO-002 / SAO-004).
    completedRow = await terminalCompleteExport(db, {
      afterDomainComplete: afterDomainComplete
        ? async () => {
            await afterDomainComplete({ exportId, jobId });
          }
        : undefined,
      artifactBytes: uploaded.artifactBytes,
      artifactChecksum: uploaded.artifactChecksum,
      attemptToken,
      evidenceCount,
      exportId,
      expiresAt,
      jobId,
      requestedBy,
      storageKey: uploaded.storageKey,
      workerId,
    });
  } finally {
    await artifact.dispose();
  }

  if (!completedRow) {
    // Lost race: cancel or another fenced attempt won. Never purge a completed
    // row's published key — only delete our attempt-unique object (SAO-002).
    const current = await exportsModel.get(exportId);
    if (current?.status === 'completed') {
      if (current.storageKey !== storageKey) {
        await safeDeleteOwned(storage, storageKey);
      }
      await jobs.cancel(jobId);
      return { claimed: true, exportId, jobId, outcome: 'cancelled' };
    }
    await safeDeleteOwned(storage, storageKey, exportsModel, exportId);
    await jobs.cancel(jobId);
    return { claimed: true, exportId, jobId, outcome: 'cancelled' };
  }

  return { claimed: true, exportId, jobId, outcome: 'completed' };
};
