/**
 * Cancel path for AdminAuditExportService (SAO-009).
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformAuditExportKind } from '@/database/models/platform';
import { PlatformAuditExportModel, PlatformJobModel } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AdminAuditExportsCancelInput } from '../../contracts/adminAudit';
import { getEnterpriseErrorBody, throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import {
  bestEffortDeleteCancelOutbox,
  collectCancelPurgeKeys,
  throwAlreadyTerminalCancel,
} from './exportServiceCancelPurge';
import { accessLogResultForError, toExportPublic } from './exportServiceShared';
import type { AuditExportArtifactStorage } from './exportStorage';

export type ExportCancelHost = {
  assertConversationExportAccess: (
    params: { actorPermissions?: readonly string[]; actorUserId: string },
    kind: PlatformAuditExportKind | undefined,
  ) => Promise<{ canReadConversations: boolean; permissions: string[] }>;
  db: LobeChatDatabase | Transaction;
  exportsModel: PlatformAuditExportModel;
  getStorage: () => AuditExportArtifactStorage;
  inTransaction: <T>(callback: (tx: LobeChatDatabase | Transaction) => Promise<T>) => Promise<T>;
};

export const cancelExport = async (
  host: ExportCancelHost,
  params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    /**
     * Test seam: after pre-TX terminal short-circuit, before the cancel TX.
     * Used to interleave a concurrent complete between the service's get() and cancel().
     */
    beforeCancelTx?: (info: { exportId: string }) => Promise<void> | void;
    input: AdminAuditExportsCancelInput;
  },
) => {
  const filterSummary = buildAuditFilterSummary({});
  try {
    const existing = await host.exportsModel.get(params.input.id);
    if (!existing) {
      await appendAuditAccessLog(host.db, {
        action: 'admin.audit.exports.cancel',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'not_found' },
        filterSummary,
        reason: params.input.reason,
        result: 'failure',
        targetId: params.input.id,
        targetType: 'audit_export',
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        httpCode: 'NOT_FOUND',
      });
    }

    await host.assertConversationExportAccess(
      { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
      existing.kind,
    );

    if (PlatformAuditExportModel.isTerminal(existing.status)) {
      return await throwAlreadyTerminalCancel(host.db, {
        actorUserId: params.actorUserId,
        filterSummary,
        reason: params.input.reason,
        status: existing.status,
        targetId: existing.id,
      });
    }

    // Test seam: pause after pre-TX terminal check, before the cancel TX (SAO-001 race).
    if (params.beforeCancelTx) {
      await params.beforeCancelTx({ exportId: existing.id });
    }

    // SAO-001: cancel is a single fenced conditional transition. If cancel()
    // matches no row (concurrent completion), commit an empty TX, then append a
    // durable failure audit and throw — never roll back the audit with the throw.
    const cancelOutcome = await host.inTransaction(async (tx) => {
      const exportsTx = new PlatformAuditExportModel(tx);
      const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);

      const cancelled = await exportsTx.cancel(existing.id);
      if (!cancelled) {
        const current = (await exportsTx.get(existing.id)) ?? existing;
        return { kind: 'conflict' as const, status: current.status, targetId: current.id };
      }

      if (cancelled.jobId) {
        await jobsTx.cancel(cancelled.jobId);
      }

      // Purge only keys owned by this cancelled row (upload intent / storageKey).
      // Never invent a deterministic key that could collide with a concurrent winner.
      for (const key of collectCancelPurgeKeys(cancelled, { includeLiveStorageKey: true })) {
        await exportsTx.enqueueArtifactObjectPurge(cancelled.id, key);
      }

      await appendAuditAccessLog(tx, {
        action: 'admin.audit.exports.cancel',
        actorUserId: params.actorUserId,
        afterDiff: { status: cancelled.status },
        filterSummary,
        reason: params.input.reason,
        required: true,
        result: 'success',
        targetId: cancelled.id,
        targetType: 'audit_export',
      });

      return { kind: 'cancelled' as const, row: cancelled };
    });

    if (cancelOutcome.kind === 'conflict') {
      // Durable audit outside the cancelled TX (required: true must survive the throw).
      return await throwAlreadyTerminalCancel(host.db, {
        actorUserId: params.actorUserId,
        filterSummary,
        reason: params.input.reason,
        required: true,
        status: cancelOutcome.status,
        targetId: cancelOutcome.targetId,
      });
    }

    const row = cancelOutcome.row;

    // Best-effort immediate delete outside the TX (durable outbox if S3 fails).
    await bestEffortDeleteCancelOutbox(host, existing.id, row);

    // Reload after purge cleanup so the public projection never returns the
    // internal purge payload that was written inside the cancel TX (F5).
    const latest = (await host.exportsModel.get(existing.id)) ?? row;
    return toExportPublic(latest);
  } catch (error) {
    if (
      getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND ||
      getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT
    ) {
      throw error;
    }
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.exports.cancel',
      actorUserId: params.actorUserId,
      afterDiff: { error: accessLogResultForError(error) },
      filterSummary,
      reason: params.input.reason,
      result: accessLogResultForError(error),
      targetId: params.input.id,
      targetType: 'audit_export',
    });
    throw error;
  }
};
