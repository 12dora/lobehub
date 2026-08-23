/**
 * Create / publish path for AdminAuditExportService.
 * Create + enqueue + required audit commit together (F1).
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformAuditExportItem } from '@/database/models/platform';
import { PlatformAuditExportModel, PlatformJobModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { AdminAuditExportsCreateInputParsed } from '../../contracts/adminAudit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import { assertConversationAccessEnabled } from './contentPolicy';
import {
  buildAuditExportClientIdempotencyKey,
  buildAuditExportJobIdempotencyKey,
  parseAuditExportJobInput,
  PLATFORM_AUDIT_EXPORT_JOB_TYPE,
} from './exportConstants';
import type { ExportServiceHost } from './exportServiceHost';
import {
  accessLogResultForError,
  freezeFilterSnapshot,
  isConversationExportKind,
  isDeniedError,
  toExportPublic,
} from './exportServiceShared';
import { resolveAuditTimeWindow } from './timeWindow';

const findExportByClientIdempotencyKey = async (
  host: ExportServiceHost,
  actorUserId: string,
  clientKey: string,
): Promise<PlatformAuditExportItem | undefined> => {
  const job = await host.jobsModel.findByIdempotencyKey(
    PLATFORM_AUDIT_EXPORT_JOB_TYPE,
    buildAuditExportClientIdempotencyKey(actorUserId, clientKey),
  );
  if (!job) return undefined;
  const parsed = parseAuditExportJobInput(job.input as Record<string, unknown>);
  if (!parsed) return undefined;
  return host.exportsModel.get(parsed.exportId);
};

const resolveCreateMessageBodies = (
  input: AdminAuditExportsCreateInputParsed,
  policy: {
    contentAccessMode: string;
    messageBodyInExport: boolean;
  },
): boolean => {
  if (input.kind !== 'conversations' || !input.includeMessageBodies) return false;
  if (policy.contentAccessMode !== 'content_allowed' || !policy.messageBodyInExport) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
      details: {
        reason: 'message_body_in_export_not_allowed',
        contentAccessMode: policy.contentAccessMode,
        messageBodyInExport: policy.messageBodyInExport,
      },
      httpCode: 'FORBIDDEN',
      message: 'Message bodies are not allowed in audit exports by policy',
    });
  }
  return true;
};

/**
 * Create + enqueue + required audit must commit together so workers cannot
 * claim a job for a request that never recorded its success audit (F1).
 * Client idempotency (when set) uses job (type, key) dedup + export.job_id unique
 * so concurrent publishers of the same logical key leave at most one export+job.
 */
const publishExportInTransaction = async (
  host: ExportServiceHost,
  params: {
    actorUserId: string;
    clientIdempotencyKey: string | undefined;
    filterSnapshot: ReturnType<typeof freezeFilterSnapshot>;
    filterSummary: ReturnType<typeof buildAuditFilterSummary>;
    includesMessageBodies: boolean;
    kind: AdminAuditExportsCreateInputParsed['kind'];
    reason: AdminAuditExportsCreateInputParsed['reason'];
  },
) => {
  return host.inTransaction(async (tx) => {
    const exportsTx = new PlatformAuditExportModel(tx);
    const jobsTx = new PlatformJobModel(tx as LobeChatDatabase);

    const created = await exportsTx.create({
      filterSnapshot: params.filterSnapshot,
      includesMessageBodies: params.includesMessageBodies,
      kind: params.kind,
      requestedBy: params.actorUserId,
    });

    if (host.afterCreateExport) {
      await host.afterCreateExport({ exportId: created.id });
    }

    const jobIdempotencyKey = params.clientIdempotencyKey
      ? buildAuditExportClientIdempotencyKey(params.actorUserId, params.clientIdempotencyKey)
      : buildAuditExportJobIdempotencyKey(created.id);

    const { created: jobCreated, job } = await jobsTx.enqueue({
      idempotencyKey: jobIdempotencyKey,
      input: { exportId: created.id },
      maxAttempts: 3,
      requestedBy: params.actorUserId,
      type: PLATFORM_AUDIT_EXPORT_JOB_TYPE,
    });

    // Concurrent loser: another TX already published under this client key.
    // Abort so our export row rolls back; caller reloads the winner.
    if (params.clientIdempotencyKey && !jobCreated) {
      const winnerId = parseAuditExportJobInput(job.input as Record<string, unknown>)?.exportId;
      if (winnerId && winnerId !== created.id) {
        throw new Error('AUDIT_EXPORT_PUBLICATION_DEDUP');
      }
    }

    if (host.afterEnqueue) {
      await host.afterEnqueue({ exportId: created.id, jobId: job.id });
    }

    const linked = await exportsTx.setJobId(created.id, job.id);
    if (!linked || linked.jobId !== job.id) {
      throw new Error('EXPORT_JOB_LINK_FAILED');
    }

    await appendAuditAccessLog(tx, {
      action: 'admin.audit.exports.create',
      actorUserId: params.actorUserId,
      afterDiff: {
        includesMessageBodies: params.includesMessageBodies,
        kind: linked.kind,
        status: linked.status,
      },
      filterSummary: params.filterSummary,
      reason: params.reason,
      required: true,
      result: 'success',
      targetId: linked.id,
      targetType: 'audit_export',
    });

    return linked;
  });
};

export const createExport = async (
  host: ExportServiceHost,
  params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    /**
     * Optional client mutation idempotency key. Concurrent or retried create/publish
     * calls with the same key converge on exactly one export + one job (return the
     * existing row). When omitted, each call mints a new export (export-id job key).
     */
    idempotencyKey?: string;
    input: AdminAuditExportsCreateInputParsed;
  },
) => {
  const filterSummary = buildAuditFilterSummary({
    action: params.input.action,
    actions: params.input.actions,
    actorUserId: params.input.actorUserId,
    from: params.input.from,
    hasQ: Boolean(params.input.q),
    includeBody: params.input.includeMessageBodies,
    kind: params.input.kind,
    result: params.input.result,
    results: params.input.results,
    targetId: params.input.targetId,
    targetType: params.input.targetType,
    to: params.input.to,
    topicId: params.input.topicId,
    userId: params.input.userId,
  });
  const clientIdempotencyKey =
    params.idempotencyKey && params.idempotencyKey.length > 0 ? params.idempotencyKey : undefined;

  try {
    await host.assertConversationExportAccess(
      { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
      params.input.kind,
    );

    // Fast path: prior successful publication under this client key.
    if (clientIdempotencyKey) {
      const existing = await findExportByClientIdempotencyKey(
        host,
        params.actorUserId,
        clientIdempotencyKey,
      );
      if (existing) return toExportPublic(existing);
    }

    const policy = await host.policyModel.getOrCreate();
    // Conversation / timeline exports are conversation surfaces — honor the kill-switch.
    if (isConversationExportKind(params.input.kind)) {
      assertConversationAccessEnabled(policy.contentAccessMode);
    }
    const window = resolveAuditTimeWindow({
      from: params.input.from,
      maxListWindowDays: policy.maxListWindowDays,
      to: params.input.to,
    });

    const includesMessageBodies = resolveCreateMessageBodies(params.input, policy);

    const filterSnapshot = freezeFilterSnapshot(params.input, window, {
      exportArtifactRetentionDays: policy.exportArtifactRetentionDays,
      maxExportRows: policy.maxExportRows,
      revision: policy.revision,
    });

    const linkedRow = await publishExportInTransaction(host, {
      actorUserId: params.actorUserId,
      clientIdempotencyKey,
      filterSnapshot,
      filterSummary,
      includesMessageBodies,
      kind: params.input.kind,
      reason: params.input.reason,
    });

    return toExportPublic(linkedRow);
  } catch (error) {
    // Concurrent loser under the same client key: return the winning export (dedup).
    // Do not swallow auth/policy denials — only publication races / link conflicts.
    if (clientIdempotencyKey && !isDeniedError(error)) {
      const existing = await findExportByClientIdempotencyKey(
        host,
        params.actorUserId,
        clientIdempotencyKey,
      );
      if (existing) return toExportPublic(existing);
    }

    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.exports.create',
      actorUserId: params.actorUserId,
      afterDiff: {
        error: accessLogResultForError(error) === 'denied' ? 'denied' : 'failure',
        kind: params.input.kind,
      },
      filterSummary,
      reason: params.input.reason,
      result: accessLogResultForError(error),
      targetType: 'audit_export',
    });
    throw error;
  }
};
