/**
 * Host surface for AdminAuditExportService domain modules (create / list / get / download).
 */

import type {
  PlatformAuditExportKind,
  PlatformAuditExportModel,
  PlatformAuditPolicyModel,
  PlatformJobModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { ActorAuthParams } from './exportServiceShared';
import type { AuditExportArtifactStorage } from './exportStorage';

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

export type ExportServiceHost = {
  afterCreateExport?: AdminAuditExportServiceOptions['afterCreateExport'];
  afterEnqueue?: AdminAuditExportServiceOptions['afterEnqueue'];
  assertConversationExportAccess: (
    params: ActorAuthParams,
    kind: PlatformAuditExportKind | undefined,
  ) => Promise<{ canReadConversations: boolean; permissions: string[] }>;
  db: LobeChatDatabase | Transaction;
  exportsModel: PlatformAuditExportModel;
  getStorage: () => AuditExportArtifactStorage;
  inTransaction: <T>(callback: (tx: LobeChatDatabase | Transaction) => Promise<T>) => Promise<T>;
  jobsModel: PlatformJobModel;
  policyModel: PlatformAuditPolicyModel;
};
