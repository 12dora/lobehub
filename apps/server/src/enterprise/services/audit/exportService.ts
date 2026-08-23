/**
 * Admin audit A3 export orchestration (create / list / get / download / cancel).
 * Self-audits success/failure/denial without free text q, message bodies, or download URLs.
 *
 * Security: AUDIT_EXPORT alone never lists/gets/downloads/cancels conversation or
 * user_timeline exports (would bypass AUDIT_CONVERSATION_READ). Conversation kinds
 * require server-derived platformAuth permissions on every operation.
 *
 * Split (SAO-009): public DTO helpers live in exportServiceShared; cancel/download
 * in sibling modules.
 */

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { PlatformAuditExportKind } from '@/database/models/platform';
import {
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
import { assertPlatformPermission, loadPlatformAuthContext } from '../../guards/platformPermission';
import { cancelExport } from './exportServiceCancel';
import { createExport } from './exportServiceCreate';
import { downloadExport } from './exportServiceDownload';
import type { AdminAuditExportServiceOptions, ExportServiceHost } from './exportServiceHost';
import { getExport, listExports } from './exportServiceRead';
import type { ActorAuthParams } from './exportServiceShared';
import { isConversationExportKind } from './exportServiceShared';
import { type AuditExportArtifactStorage, AuditExportPrivateS3Storage } from './exportStorage';

export type { AdminAuditExportServiceOptions } from './exportServiceHost';
export { toExportPublic } from './exportServiceShared';

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
   * Run work in a real DB transaction when `this.db` is a connection root.
   * When already inside a Transaction, invoke the callback on that handle.
   * Workers cannot claim jobs enqueued here until the outer TX commits.
   */
  private inTransaction = async <T>(
    callback: (tx: LobeChatDatabase | Transaction) => Promise<T>,
  ): Promise<T> => {
    const database = this.db as LobeChatDatabase;
    return typeof database.transaction === 'function'
      ? database.transaction(callback)
      : callback(this.db);
  };

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

  private host = (): ExportServiceHost => ({
    afterCreateExport: this.afterCreateExport,
    afterEnqueue: this.afterEnqueue,
    assertConversationExportAccess: this.assertConversationExportAccess,
    db: this.db,
    exportsModel: this.exportsModel,
    getStorage: () => this.storage,
    inTransaction: this.inTransaction,
    jobsModel: this.jobsModel,
    policyModel: this.policyModel,
  });

  create = async (params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    /**
     * Optional client mutation idempotency key. Concurrent or retried create/publish
     * calls with the same key converge on exactly one export + one job (return the
     * existing row). When omitted, each call mints a new export (export-id job key).
     */
    idempotencyKey?: string;
    input: AdminAuditExportsCreateInputParsed;
  }) => createExport(this.host(), params);

  list = async (params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    input: AdminAuditExportsListInputParsed;
  }) => listExports(this.host(), params);

  get = async (params: { actorPermissions?: readonly string[]; actorUserId: string; id: string }) =>
    getExport(this.host(), params);

  download = async (params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    input: AdminAuditExportsDownloadInput;
  }) => downloadExport(this.host(), params);

  cancel = async (params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    input: AdminAuditExportsCancelInput;
    /** Test seam: after claim, before cancel TX (e.g. inject concurrent cancel). */
    beforeCancelTx?: (info: { exportId: string }) => Promise<void> | void;
  }) =>
    cancelExport(
      {
        assertConversationExportAccess: this.assertConversationExportAccess,
        db: this.db,
        exportsModel: this.exportsModel,
        getStorage: () => this.storage,
        inTransaction: this.inTransaction,
      },
      params,
    );
}
