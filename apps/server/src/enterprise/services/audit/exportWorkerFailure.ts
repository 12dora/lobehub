/** Terminal / transient failure settlement for a claimed audit export job. */

import type { PlatformAuditExportModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { AuditExportArtifactStorage } from './exportStorage';
import type { ProcessNextAuditExportResult } from './exportWorker';
import {
  AuditExportArtifactTooLargeError,
  AuditExportCancelledError,
  AuditExportInvalidFilterError,
  AuditExportLeaseLostError,
  AuditExportMaxRowsError,
  isTerminalContractError,
} from './exportWorkerErrors';
import { safeDeleteOwned, terminalCancelExport, terminalFailExport } from './exportWorkerTerminal';
import { mapExportFailureCode } from './jobError';

export const settleExportJobFailure = async (params: {
  db: LobeChatDatabase;
  error: unknown;
  exportId: string;
  exportsModel: PlatformAuditExportModel;
  jobId: string;
  storage: AuditExportArtifactStorage;
  storageKey: string;
  workerId: string;
}): Promise<ProcessNextAuditExportResult> => {
  const { db, error, exportId, exportsModel, jobId, storage, storageKey, workerId } = params;

  if (error instanceof AuditExportLeaseLostError) {
    // Lease loss is NOT user cancellation — leave domain + platform job as-is for reclaim.
    // Best-effort delete of our attempt key only (never the published winner).
    await safeDeleteOwned(storage, storageKey);
    return { claimed: true, exportId, jobId, outcome: 'skipped' };
  }

  if (error instanceof AuditExportCancelledError) {
    const exportRow = await exportsModel.get(exportId);
    await terminalCancelExport(db, {
      exportId,
      jobId,
      requestedBy: exportRow?.requestedBy ?? 'system',
      workerId,
    });
    await safeDeleteOwned(storage, storageKey, exportsModel, exportId);
    return { claimed: true, exportId, jobId, outcome: 'cancelled' };
  }

  // Bounded enum only — never Error.name / free-form message as public code (F3).
  const code = isTerminalContractError(error)
    ? error instanceof AuditExportMaxRowsError
      ? 'MAX_EXPORT_ROWS_EXCEEDED'
      : error instanceof AuditExportInvalidFilterError
        ? 'INVALID_FILTER_SNAPSHOT'
        : error instanceof AuditExportArtifactTooLargeError
          ? 'ARTIFACT_TOO_LARGE'
          : mapExportFailureCode(error)
    : mapExportFailureCode(error);

  const exportRow = await exportsModel.get(exportId);
  const requestedBy = exportRow?.requestedBy ?? 'system';

  if (isTerminalContractError(error)) {
    await terminalFailExport(db, {
      code,
      exportId,
      jobId,
      requestedBy,
      terminal: true,
      workerId,
    });
    await safeDeleteOwned(storage, storageKey, exportsModel, exportId);
    return { claimed: true, exportId, jobId, outcome: 'failed' };
  }

  // Transient / unknown: atomically requeue, or terminalize domain/job/audit
  // together when this attempt exhausts the budget.
  await safeDeleteOwned(storage, storageKey);
  const terminal = await terminalFailExport(db, {
    code,
    exportId,
    jobId,
    requestedBy,
    terminal: false,
    workerId,
  });

  if (terminal) {
    await safeDeleteOwned(storage, storageKey, exportsModel, exportId);
    return { claimed: true, exportId, jobId, outcome: 'failed' };
  }

  return { claimed: true, exportId, jobId, outcome: 'retry' };
};
