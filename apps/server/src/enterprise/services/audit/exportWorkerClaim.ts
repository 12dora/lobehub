/** Domain-status short-circuits for a claimed audit export job. */

import type {
  PlatformAuditExportItem,
  PlatformAuditExportModel,
  PlatformJobModel,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { AuditExportArtifactStorage } from './exportStorage';
import type { ProcessNextAuditExportResult } from './exportWorker';
import { safeDeleteOwned, terminalCancelExport } from './exportWorkerTerminal';

export const settleNonRunnableExport = (params: {
  db: LobeChatDatabase;
  exportId: string;
  exportRow: PlatformAuditExportItem | undefined;
  exportsModel: PlatformAuditExportModel;
  jobId: string;
  jobs: PlatformJobModel;
  storage: AuditExportArtifactStorage;
  workerId: string;
}): Promise<ProcessNextAuditExportResult> | null => {
  const { db, exportId, exportRow, exportsModel, jobId, jobs, storage, workerId } = params;

  if (!exportRow) {
    return (async () => {
      await jobs.fail({
        error: { code: 'NOT_FOUND' },
        jobId,
        terminal: true,
        workerId,
      });
      return { claimed: true, exportId, jobId, outcome: 'failed' };
    })();
  }

  if (exportRow.status === 'cancelled') {
    return (async () => {
      await terminalCancelExport(db, {
        exportId,
        jobId,
        requestedBy: exportRow.requestedBy,
        workerId,
      });
      // Only purge keys we know about from the cancelled row — never a winner's key.
      const knownKey =
        exportRow.storageKey ||
        (exportRow.error as { purgeStorageKey?: string } | null)?.purgeStorageKey ||
        null;
      if (knownKey) {
        await safeDeleteOwned(storage, knownKey, exportsModel, exportId);
      }
      return { claimed: true, exportId, jobId, outcome: 'cancelled' };
    })();
  }

  if (exportRow.status === 'completed') {
    return (async () => {
      await jobs.complete({
        jobId,
        resultSummary: { exportId, rowCount: exportRow.rowCount ?? 0 },
        workerId,
      });
      return { claimed: true, exportId, jobId, outcome: 'skipped' };
    })();
  }

  if (exportRow.status === 'failed' || exportRow.status === 'expired') {
    return (async () => {
      await jobs.fail({
        error: { code: 'EXPORT_TERMINAL' },
        jobId,
        terminal: true,
        workerId,
      });
      return { claimed: true, exportId, jobId, outcome: 'skipped' };
    })();
  }

  return null;
};
