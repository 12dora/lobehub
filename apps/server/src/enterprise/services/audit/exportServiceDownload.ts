/**
 * Download path for AdminAuditExportService.
 * Integrity before signed URL; sign first, then required success audit.
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformAuditExportItem } from '@/database/models/platform';

import type { AdminAuditExportsDownloadInput } from '../../contracts/adminAudit';
import { ADMIN_AUDIT_EXPORT_DOWNLOAD_URL_TTL_SECONDS } from '../../contracts/adminAudit';
import { getEnterpriseErrorBody, throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import { assertConversationAccessEnabled } from './contentPolicy';
import type { ExportServiceHost } from './exportServiceHost';
import { accessLogResultForError, isConversationExportKind } from './exportServiceShared';
import { checksumsMatch } from './exportStorage';

type DownloadParams = {
  actorPermissions?: readonly string[];
  actorUserId: string;
  input: AdminAuditExportsDownloadInput;
};

const appendDownloadFailure = async (
  host: ExportServiceHost,
  params: DownloadParams,
  args: {
    error: string;
    extraAfterDiff?: Record<string, unknown>;
    filterSummary: ReturnType<typeof buildAuditFilterSummary>;
    targetId: string;
  },
) => {
  await appendAuditAccessLog(host.db, {
    action: 'admin.audit.exports.download',
    actorUserId: params.actorUserId,
    afterDiff: { error: args.error, ...args.extraAfterDiff },
    filterSummary: args.filterSummary,
    reason: params.input.reason,
    result: 'failure',
    targetId: args.targetId,
    targetType: 'audit_export',
  });
};

const failDownloadIntegrity = async (
  host: ExportServiceHost,
  params: DownloadParams,
  filterSummary: ReturnType<typeof buildAuditFilterSummary>,
  rowId: string,
  error: string,
) => {
  await appendDownloadFailure(host, params, { error, filterSummary, targetId: rowId });
  return throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
    details: { reason: 'export_integrity_failed' },
    httpCode: 'BAD_REQUEST',
    message: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
  });
};

/**
 * Integrity before issuing URL: length + trusted SHA-256 (detect same-length corruption).
 * Stream-hash the object (F10) — never buffer the full artifact for download verify.
 */
const verifyDownloadArtifact = async (
  host: ExportServiceHost,
  params: DownloadParams,
  filterSummary: ReturnType<typeof buildAuditFilterSummary>,
  row: PlatformAuditExportItem,
  storageKey: string,
): Promise<void> => {
  const storage = host.getStorage();
  const meta = await storage.getObjectMetadata(storageKey);
  if (row.artifactBytes != null && meta.contentLength !== row.artifactBytes) {
    return failDownloadIntegrity(host, params, filterSummary, row.id, 'size_mismatch');
  }

  const objectHash = await storage.hashObject(storageKey);
  if (row.artifactBytes != null && objectHash.artifactBytes !== row.artifactBytes) {
    return failDownloadIntegrity(host, params, filterSummary, row.id, 'size_mismatch');
  }
  if (!checksumsMatch(objectHash.artifactChecksum, row.artifactChecksum)) {
    return failDownloadIntegrity(host, params, filterSummary, row.id, 'checksum_mismatch');
  }

  // Shrink the replace-after-verify window: re-check size immediately before sign.
  // Full TOCTOU elimination requires immutable/versioned object keys (see OOS).
  const metaAfter = await storage.getObjectMetadata(storageKey);
  if (metaAfter.contentLength !== objectHash.artifactBytes) {
    return failDownloadIntegrity(host, params, filterSummary, row.id, 'size_mismatch_after_verify');
  }
};

export const downloadExport = async (host: ExportServiceHost, params: DownloadParams) => {
  const filterSummary = buildAuditFilterSummary({});
  try {
    const row = await host.exportsModel.get(params.input.id);
    if (!row) {
      await appendDownloadFailure(host, params, {
        error: 'not_found',
        filterSummary,
        targetId: params.input.id,
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        httpCode: 'NOT_FOUND',
      });
    }

    // Conversation permission before any signed URL / storage access (download bypass guard).
    await host.assertConversationExportAccess(
      { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
      row.kind,
    );

    // Live kill-switch: conversation surfaces stay closed even for already-completed artifacts.
    if (isConversationExportKind(row.kind)) {
      const livePolicy = await host.policyModel.getOrCreate();
      assertConversationAccessEnabled(livePolicy.contentAccessMode);
    }

    if (row.status === 'expired' || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
      if (row.status !== 'expired') {
        await host.exportsModel.expired(row.id);
      }
      await appendDownloadFailure(host, params, {
        error: 'expired',
        filterSummary,
        targetId: row.id,
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        details: { reason: 'export_expired' },
        httpCode: 'NOT_FOUND',
        message: 'Export artifact expired',
      });
    }

    if (row.status !== 'completed' || !row.storageKey) {
      await appendDownloadFailure(host, params, {
        error: 'not_ready',
        extraAfterDiff: { status: row.status },
        filterSummary,
        targetId: row.id,
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        details: { reason: 'export_not_ready', status: row.status },
        httpCode: 'BAD_REQUEST',
        message: 'Export is not ready for download',
      });
    }

    await verifyDownloadArtifact(host, params, filterSummary, row, row.storageKey);

    const ttl = ADMIN_AUDIT_EXPORT_DOWNLOAD_URL_TTL_SECONDS;

    // Sign first, then audit success — never record a successful download if
    // signing fails (which previously left a false success + catch failure pair).
    const downloadUrl = await host.getStorage().getSignedDownloadUrl(row.storageKey, ttl);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    // Fail closed: never return a signed URL without a durable access record.
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.exports.download',
      actorUserId: params.actorUserId,
      afterDiff: {
        artifactBytes: row.artifactBytes,
        // Never log URL or storageKey
        signedUrlTtlSeconds: ttl,
      },
      filterSummary,
      reason: params.input.reason,
      required: true,
      result: 'success',
      targetId: row.id,
      targetType: 'audit_export',
    });

    return {
      artifactBytes: row.artifactBytes,
      artifactChecksum: row.artifactChecksum,
      downloadUrl,
      expiresAt,
      id: row.id,
    };
  } catch (error) {
    if (
      getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND ||
      getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT
    ) {
      throw error;
    }
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.exports.download',
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
