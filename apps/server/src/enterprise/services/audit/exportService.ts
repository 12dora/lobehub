/**
 * Admin audit A3 export orchestration (create / list / get / download / cancel).
 * Self-audits success/failure/denial without free text q, message bodies, or download URLs.
 *
 * Security: AUDIT_EXPORT alone never lists/gets/downloads/cancels conversation or
 * user_timeline exports (would bypass AUDIT_CONVERSATION_READ). Conversation kinds
 * require server-derived platformAuth permissions on every operation.
 */

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import {
  type PlatformAuditExportFilterSnapshot,
  type PlatformAuditExportItem,
  type PlatformAuditExportKind,
  PlatformAuditExportModel,
  PlatformAuditPolicyModel,
  PlatformJobModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  AdminAuditExportsCancelInput,
  AdminAuditExportsCreateInputParsed,
  AdminAuditExportsDownloadInput,
  AdminAuditExportsListInputParsed,
} from '../../contracts/adminAudit';
import { ADMIN_AUDIT_EXPORT_DOWNLOAD_URL_TTL_SECONDS } from '../../contracts/adminAudit';
import { getEnterpriseErrorBody, throwEnterpriseError } from '../../guards/enterpriseErrors';
import { assertPlatformPermission, loadPlatformAuthContext } from '../../guards/platformPermission';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import {
  buildAuditExportJobIdempotencyKey,
  PLATFORM_AUDIT_EXPORT_JOB_TYPE,
} from './exportConstants';
import {
  type AuditExportArtifactStorage,
  AuditExportPrivateS3Storage,
  buildAuditExportStorageKey,
  verifyArtifactChecksum,
} from './exportStorage';
import { resolveAuditTimeWindow } from './timeWindow';

const CONVERSATION_EXPORT_KINDS: readonly PlatformAuditExportKind[] = [
  'conversations',
  'user_timeline',
];

const isConversationExportKind = (kind: PlatformAuditExportKind | undefined): boolean =>
  kind === 'conversations' || kind === 'user_timeline';

const isDeniedError = (error: unknown): boolean => {
  const code = getEnterpriseErrorBody(error)?.code;
  return (
    code === PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED ||
    code === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED ||
    code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED ||
    code === ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED ||
    code === ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED
  );
};

const accessLogResultForError = (error: unknown): 'denied' | 'failure' =>
  isDeniedError(error) ? 'denied' : 'failure';

/** Public projection — never includes storageKey. */
export const toExportPublic = (row: PlatformAuditExportItem) => ({
  artifactBytes: row.artifactBytes,
  artifactChecksum: row.artifactChecksum,
  createdAt: row.createdAt,
  error: row.error,
  expiresAt: row.expiresAt,
  filterSnapshot: row.filterSnapshot ?? {},
  finishedAt: row.finishedAt,
  id: row.id,
  includesMessageBodies: row.includesMessageBodies,
  jobId: row.jobId,
  kind: row.kind,
  requestedBy: row.requestedBy,
  rowCount: row.rowCount,
  startedAt: row.startedAt,
  status: row.status,
  updatedAt: row.updatedAt,
});

const freezeFilterSnapshot = (
  input: AdminAuditExportsCreateInputParsed,
  window: { from: Date; to: Date },
  policy: {
    exportArtifactRetentionDays: number;
    maxExportRows: number;
    revision: number;
  },
): PlatformAuditExportFilterSnapshot => {
  const snap: PlatformAuditExportFilterSnapshot = {
    exportArtifactRetentionDays: policy.exportArtifactRetentionDays,
    from: window.from.toISOString(),
    maxExportRows: policy.maxExportRows,
    policyRevision: policy.revision,
    to: window.to.toISOString(),
  };
  if (input.kind === 'operation_logs') {
    if (input.action) snap.action = input.action;
    if (input.actions?.length) snap.actions = input.actions;
    if (input.actorUserId) snap.actorUserId = input.actorUserId;
    if (input.requestId) snap.requestId = input.requestId;
    if (input.result) snap.result = input.result;
    if (input.results?.length) snap.results = input.results;
    if (input.targetId) snap.targetId = input.targetId;
    if (input.targetType) snap.targetType = input.targetType;
  }
  if ((input.kind === 'conversations' || input.kind === 'user_timeline') && input.userId)
    snap.userId = input.userId;
  if (input.kind === 'conversations') {
    if (input.q) snap.q = input.q;
    if (input.topicId) snap.topicId = input.topicId;
  }
  return snap;
};

type ActorAuthParams = {
  actorPermissions?: readonly string[];
  actorUserId: string;
};

export type AdminAuditExportServiceOptions = {
  /**
   * Test seam: after export row create, before job enqueue.
   * Throw to exercise orphan-pending compensation.
   */
  afterCreateExport?: (info: { exportId: string }) => Promise<void> | void;
  /**
   * Test seam: after successful enqueue, before setJobId.
   * Throw to exercise link-failure compensation (job cancelled, export failed).
   */
  afterEnqueue?: (info: { exportId: string; jobId: string }) => Promise<void> | void;
  storage?: AuditExportArtifactStorage;
};

export class AdminAuditExportService {
  private readonly exportsModel: PlatformAuditExportModel;
  private readonly jobsModel: PlatformJobModel;
  private readonly policyModel: PlatformAuditPolicyModel;
  /** Injected storage is preserved as-is; production S3 is created lazily. */
  private readonly injectedStorage?: AuditExportArtifactStorage;
  private readonly afterCreateExport?: AdminAuditExportServiceOptions['afterCreateExport'];
  private readonly afterEnqueue?: AdminAuditExportServiceOptions['afterEnqueue'];
  private lazyProductionStorage?: AuditExportArtifactStorage;

  constructor(
    private readonly db: LobeChatDatabase | Transaction,
    options?: AdminAuditExportServiceOptions,
  ) {
    this.exportsModel = new PlatformAuditExportModel(db);
    // PlatformJobModel requires LobeChatDatabase (not Transaction) for claim/enqueue paths.
    this.jobsModel = new PlatformJobModel(db as LobeChatDatabase);
    this.policyModel = new PlatformAuditPolicyModel(db);
    // Do not eagerly construct private S3: create/list/get never touch storage.
    // Download/cancel resolve production storage only when needed (worker has its own).
    this.injectedStorage = options?.storage;
    this.afterCreateExport = options?.afterCreateExport;
    this.afterEnqueue = options?.afterEnqueue;
  }

  /**
   * Artifact storage for download / cancel only.
   * Injected storage is returned as-is; otherwise private S3 is created on first use.
   */
  private get storage(): AuditExportArtifactStorage {
    if (this.injectedStorage) return this.injectedStorage;
    if (!this.lazyProductionStorage) {
      this.lazyProductionStorage = new AuditExportPrivateS3Storage();
    }
    return this.lazyProductionStorage;
  }

  /**
   * Resolve actor permissions from router-injected platformAuth only when provided;
   * otherwise load server-side (never trust client-supplied permission lists).
   */
  private resolveActorAuth = async (params: ActorAuthParams) => {
    if (params.actorPermissions != null) {
      return {
        actorId: params.actorUserId,
        permissions: [...params.actorPermissions],
      };
    }
    return loadPlatformAuthContext({
      db: this.db as LobeChatDatabase,
      userId: params.actorUserId,
    });
  };

  private hasConversationRead = (permissions: readonly string[]): boolean =>
    permissions.includes(PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ);

  /**
   * Enforce AUDIT_CONVERSATION_READ for conversation / user_timeline kinds.
   * Throws PLATFORM_PERMISSION_DENIED (self-audit is caller's responsibility on catch).
   */
  private assertConversationExportAccess = async (
    params: ActorAuthParams,
    kind: PlatformAuditExportKind | undefined,
  ): Promise<{ canReadConversations: boolean; permissions: string[] }> => {
    const auth = await this.resolveActorAuth(params);
    const canReadConversations = this.hasConversationRead(auth.permissions);
    if (isConversationExportKind(kind) && !canReadConversations) {
      assertPlatformPermission(auth, PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ);
    }
    return { canReadConversations, permissions: auth.permissions };
  };

  create = async (params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    input: AdminAuditExportsCreateInputParsed;
  }) => {
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

    try {
      await this.assertConversationExportAccess(
        { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
        params.input.kind,
      );

      const policy = await this.policyModel.getOrCreate();
      const window = resolveAuditTimeWindow({
        from: params.input.from,
        maxListWindowDays: policy.maxListWindowDays,
        to: params.input.to,
      });

      let includesMessageBodies = false;
      if (params.input.kind === 'conversations' && params.input.includeMessageBodies) {
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
        includesMessageBodies = true;
      }

      const filterSnapshot = freezeFilterSnapshot(params.input, window, {
        exportArtifactRetentionDays: policy.exportArtifactRetentionDays,
        maxExportRows: policy.maxExportRows,
        revision: policy.revision,
      });
      const created = await this.exportsModel.create({
        filterSnapshot,
        includesMessageBodies,
        kind: params.input.kind,
        requestedBy: params.actorUserId,
      });

      let linkedRow: PlatformAuditExportItem | null = null;
      let enqueuedJobId: string | null = null;
      try {
        if (this.afterCreateExport) {
          await this.afterCreateExport({ exportId: created.id });
        }

        const { job } = await this.jobsModel.enqueue({
          idempotencyKey: buildAuditExportJobIdempotencyKey(created.id),
          input: { exportId: created.id },
          maxAttempts: 3,
          requestedBy: params.actorUserId,
          type: PLATFORM_AUDIT_EXPORT_JOB_TYPE,
        });
        enqueuedJobId = job.id;

        if (this.afterEnqueue) {
          await this.afterEnqueue({ exportId: created.id, jobId: job.id });
        }

        const linked = await this.exportsModel.setJobId(created.id, job.id);
        // Unsuccessful link (null / wrong jobId) is failure — never treat a
        // pending row with jobId=null as success via get() fallback.
        if (!linked || linked.jobId !== job.id) {
          throw new Error('EXPORT_JOB_LINK_FAILED');
        }
        linkedRow = linked;
      } catch (enqueueOrLinkError) {
        // Never leave a permanently pending orphan with jobId = null.
        // Safe public message only — never persist raw exception text.
        await this.exportsModel.fail(created.id, {
          code: 'ENQUEUE_FAILED',
          message: 'export job enqueue or link failed',
        });
        if (enqueuedJobId) {
          await this.jobsModel.cancel(enqueuedJobId).catch(() => undefined);
        }
        throw enqueueOrLinkError;
      }

      try {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.exports.create',
          actorUserId: params.actorUserId,
          afterDiff: {
            includesMessageBodies,
            kind: linkedRow.kind,
            status: linkedRow.status,
          },
          filterSummary,
          reason: params.input.reason,
          required: true,
          result: 'success',
          targetId: linkedRow.id,
          targetType: 'audit_export',
        });
      } catch (auditError) {
        // Enqueue/link succeeded; do not mislabel as ENQUEUE_FAILED.
        await this.exportsModel.fail(created.id, {
          code: 'AUDIT_APPEND_FAILED',
          message: 'required audit access log append failed',
        });
        if (enqueuedJobId) {
          await this.jobsModel.cancel(enqueuedJobId).catch(() => undefined);
        }
        throw auditError;
      }

      return toExportPublic(linkedRow);
    } catch (error) {
      await appendAuditAccessLog(this.db, {
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

  list = async (params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    input: AdminAuditExportsListInputParsed;
  }) => {
    const filterSummary = buildAuditFilterSummary({
      cursor: params.input.cursor,
      kind: params.input.kind,
      limit: params.input.limit,
      status: params.input.status,
    });
    try {
      const { canReadConversations } = await this.assertConversationExportAccess(
        { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
        params.input.kind,
      );

      // Without conversation read: only surface operation_logs (never leak privileged exports).
      const kindFilter: PlatformAuditExportKind | undefined = canReadConversations
        ? params.input.kind
        : 'operation_logs';

      const page = await this.exportsModel.list({
        cursor: params.input.cursor,
        kind: kindFilter,
        limit: params.input.limit,
        requestedBy: params.input.mine ? params.actorUserId : undefined,
        status: params.input.status,
      });

      // Defense in depth: drop any conversation kinds if somehow present.
      const items = canReadConversations
        ? page.items
        : page.items.filter((row) => !CONVERSATION_EXPORT_KINDS.includes(row.kind));

      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.exports.list',
        actorUserId: params.actorUserId,
        afterDiff: canReadConversations
          ? undefined
          : { conversationKindsHidden: true, kindFilter: 'operation_logs' },
        filterSummary,
        result: 'success',
        targetType: 'audit_export',
      });
      return {
        items: items.map(toExportPublic),
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.exports.list',
        actorUserId: params.actorUserId,
        afterDiff: { error: accessLogResultForError(error) },
        filterSummary,
        result: accessLogResultForError(error),
        targetType: 'audit_export',
      });
      throw error;
    }
  };

  get = async (params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    id: string;
  }) => {
    const filterSummary = buildAuditFilterSummary({});
    try {
      const row = await this.exportsModel.get(params.id);
      if (!row) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.exports.get',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'not_found' },
          filterSummary,
          result: 'failure',
          targetId: params.id,
          targetType: 'audit_export',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          httpCode: 'NOT_FOUND',
        });
      }

      await this.assertConversationExportAccess(
        { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
        row.kind,
      );

      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.exports.get',
        actorUserId: params.actorUserId,
        filterSummary,
        result: 'success',
        targetId: row.id,
        targetType: 'audit_export',
      });
      return toExportPublic(row);
    } catch (error) {
      if (getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND) {
        throw error;
      }
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.exports.get',
        actorUserId: params.actorUserId,
        afterDiff: { error: accessLogResultForError(error) },
        filterSummary,
        result: accessLogResultForError(error),
        targetId: params.id,
        targetType: 'audit_export',
      });
      throw error;
    }
  };

  download = async (params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    input: AdminAuditExportsDownloadInput;
  }) => {
    const filterSummary = buildAuditFilterSummary({});
    try {
      const row = await this.exportsModel.get(params.input.id);
      if (!row) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.exports.download',
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

      // Conversation permission before any signed URL / storage access (download bypass guard).
      await this.assertConversationExportAccess(
        { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
        row.kind,
      );

      if (row.status === 'expired' || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
        if (row.status !== 'expired') {
          await this.exportsModel.expired(row.id);
        }
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.exports.download',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'expired' },
          filterSummary,
          reason: params.input.reason,
          result: 'failure',
          targetId: row.id,
          targetType: 'audit_export',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
          details: { reason: 'export_expired' },
          httpCode: 'NOT_FOUND',
          message: 'Export artifact expired',
        });
      }

      if (row.status !== 'completed' || !row.storageKey) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.exports.download',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'not_ready', status: row.status },
          filterSummary,
          reason: params.input.reason,
          result: 'failure',
          targetId: row.id,
          targetType: 'audit_export',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
          details: { reason: 'export_not_ready', status: row.status },
          httpCode: 'BAD_REQUEST',
          message: 'Export is not ready for download',
        });
      }

      // Integrity before issuing URL: length + trusted SHA-256 (detect same-length corruption).
      const failIntegrity = async (error: string) => {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.exports.download',
          actorUserId: params.actorUserId,
          afterDiff: { error },
          filterSummary,
          reason: params.input.reason,
          result: 'failure',
          targetId: row.id,
          targetType: 'audit_export',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
          details: { reason: 'export_integrity_failed' },
          httpCode: 'BAD_REQUEST',
          message: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        });
      };

      const meta = await this.storage.getObjectMetadata(row.storageKey);
      if (row.artifactBytes != null && meta.contentLength !== row.artifactBytes) {
        return failIntegrity('size_mismatch');
      }

      const objectBytes = await this.storage.getObjectBytes(row.storageKey);
      if (row.artifactBytes != null && objectBytes.byteLength !== row.artifactBytes) {
        return failIntegrity('size_mismatch');
      }
      if (!verifyArtifactChecksum(objectBytes, row.artifactChecksum)) {
        return failIntegrity('checksum_mismatch');
      }

      // Shrink the replace-after-verify window: re-check size immediately before sign.
      // Full TOCTOU elimination requires immutable/versioned object keys (see OOS).
      const metaAfter = await this.storage.getObjectMetadata(row.storageKey);
      if (metaAfter.contentLength !== objectBytes.byteLength) {
        return failIntegrity('size_mismatch_after_verify');
      }

      const ttl = ADMIN_AUDIT_EXPORT_DOWNLOAD_URL_TTL_SECONDS;

      // Sign first, then audit success — never record a successful download if
      // signing fails (which previously left a false success + catch failure pair).
      const downloadUrl = await this.storage.getSignedDownloadUrl(row.storageKey, ttl);
      const expiresAt = new Date(Date.now() + ttl * 1000);

      // Fail closed: never return a signed URL without a durable access record.
      await appendAuditAccessLog(this.db, {
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
      await appendAuditAccessLog(this.db, {
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

  cancel = async (params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    input: AdminAuditExportsCancelInput;
  }) => {
    const filterSummary = buildAuditFilterSummary({});
    try {
      const existing = await this.exportsModel.get(params.input.id);
      if (!existing) {
        await appendAuditAccessLog(this.db, {
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

      await this.assertConversationExportAccess(
        { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
        existing.kind,
      );

      if (PlatformAuditExportModel.isTerminal(existing.status)) {
        await appendAuditAccessLog(this.db, {
          action: 'admin.audit.exports.cancel',
          actorUserId: params.actorUserId,
          afterDiff: { error: 'already_terminal', status: existing.status },
          filterSummary,
          reason: params.input.reason,
          result: 'failure',
          targetId: existing.id,
          targetType: 'audit_export',
        });
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
          details: { reason: 'export_already_terminal', status: existing.status },
          httpCode: 'BAD_REQUEST',
          message: 'Export is already terminal',
        });
      }

      const cancelled = await this.exportsModel.cancel(existing.id);
      if (existing.jobId) {
        await this.jobsModel.cancel(existing.jobId);
      }

      // Best-effort object cleanup (may not exist yet)
      await this.storage
        .deleteObject(existing.storageKey ?? buildAuditExportStorageKey(existing.id))
        .catch(() => undefined);

      const row = cancelled ?? (await this.exportsModel.get(existing.id)) ?? existing;

      // Fail closed: never report a successful cancel without a durable audit record.
      await appendAuditAccessLog(this.db, {
        action: 'admin.audit.exports.cancel',
        actorUserId: params.actorUserId,
        afterDiff: { status: row.status },
        filterSummary,
        reason: params.input.reason,
        required: true,
        result: 'success',
        targetId: row.id,
        targetType: 'audit_export',
      });

      return toExportPublic(row);
    } catch (error) {
      if (
        getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND ||
        getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT
      ) {
        throw error;
      }
      await appendAuditAccessLog(this.db, {
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
}
