/**
 * Cancel-path purge + already-terminal helpers for AdminAuditExportService (SAO-009).
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type {
  ExportErrorPayload,
  PlatformAuditExportItem,
  PlatformAuditExportModel,
  PlatformAuditExportStatus,
} from '@/database/models/platform';
import { mergePurgeStorageKeys, readPurgeOutboxStorageKeys } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AdminAuditAccessFilterSummary } from '../../contracts/adminAudit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog } from './accessLog';
import type { AuditExportArtifactStorage } from './exportStorage';

export type ExportCancelPurgeHost = {
  exportsModel: PlatformAuditExportModel;
  getStorage: () => AuditExportArtifactStorage;
};

/**
 * Harvest purge keys from a cancel-path row.
 * In-TX must include live `storageKey`; post-TX must not (lost-race / leftover key).
 * Never synthesizes object keys.
 */
export const collectCancelPurgeKeys = (
  row: Pick<PlatformAuditExportItem, 'error' | 'storageKey'>,
  opts: { includeLiveStorageKey: boolean },
): string[] => {
  const outbox = readPurgeOutboxStorageKeys(row.error as ExportErrorPayload | undefined);
  if (!opts.includeLiveStorageKey) return outbox;
  return mergePurgeStorageKeys(row.storageKey, outbox);
};

export const throwAlreadyTerminalCancel = async (
  db: LobeChatDatabase | Transaction,
  params: {
    actorUserId: string;
    filterSummary: AdminAuditAccessFilterSummary;
    reason?: string | null;
    required?: boolean;
    status: PlatformAuditExportStatus;
    targetId: string;
  },
): Promise<never> => {
  await appendAuditAccessLog(db, {
    action: 'admin.audit.exports.cancel',
    actorUserId: params.actorUserId,
    afterDiff: { error: 'already_terminal', status: params.status },
    filterSummary: params.filterSummary,
    reason: params.reason,
    ...(params.required ? { required: true } : {}),
    result: 'failure',
    targetId: params.targetId,
    targetType: 'audit_export',
  });
  return throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
    details: { reason: 'export_already_terminal', status: params.status },
    httpCode: 'BAD_REQUEST',
    message: 'Export is already terminal',
  });
};

/**
 * Best-effort immediate delete outside the cancel TX (durable outbox if S3 fails).
 * Uses the cancelled-row snapshot — does not re-read keys (must not pick up the
 * live `storageKey` after in-TX enqueue).
 */
export const bestEffortDeleteCancelOutbox = async (
  host: ExportCancelPurgeHost,
  exportId: string,
  row: Pick<PlatformAuditExportItem, 'error' | 'storageKey'>,
): Promise<void> => {
  const purgeKeys = collectCancelPurgeKeys(row, { includeLiveStorageKey: false });
  for (const purgeKey of purgeKeys) {
    try {
      await host.getStorage().deleteObject(purgeKey);
      // Fence finalize with the token currently on the row (re-read after each delete).
      const latest = await host.exportsModel.get(exportId);
      const token = (latest?.error as { purgeToken?: string } | null)?.purgeToken;
      await host.exportsModel.completeArtifactObjectDelete(exportId, undefined, token, purgeKey);
    } catch {
      // leave ARTIFACT_PURGE_PENDING outbox
    }
  }
};
