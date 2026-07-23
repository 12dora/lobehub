import { eq } from 'drizzle-orm';

import {
  type NewPlatformAuditPolicy,
  PLATFORM_AUDIT_POLICY_DEFAULTS,
  PLATFORM_AUDIT_POLICY_ID,
  type PlatformAuditContentAccessMode,
  platformAuditPolicies,
  type PlatformAuditPolicyItem,
  type PlatformAuditRedactionProfile,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

export type { PlatformAuditPolicyItem };

export interface UpdatePlatformAuditPolicyParams {
  contentAccessMode?: PlatformAuditContentAccessMode;
  conversationRetentionDays?: number;
  expectedRevision: number;
  exportArtifactRetentionDays?: number;
  maxExportRows?: number;
  maxListWindowDays?: number;
  messageBodyInExport?: boolean;
  operationLogRetentionDays?: number;
  redactionProfile?: PlatformAuditRedactionProfile;
  updatedBy?: string | null;
}

/** Insert defaults — single source with schema column defaults (`PLATFORM_AUDIT_POLICY_DEFAULTS`). */
const DEFAULT_POLICY_VALUES: Omit<NewPlatformAuditPolicy, 'id'> = {
  ...PLATFORM_AUDIT_POLICY_DEFAULTS,
};

/**
 * Singleton platform audit policy repository (CAS via revision).
 */
export class PlatformAuditPolicyModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  getOrCreate = async (): Promise<PlatformAuditPolicyItem> => {
    const existing = await this.get();
    if (existing) return existing;

    const [row] = await this.db
      .insert(platformAuditPolicies)
      .values({
        ...DEFAULT_POLICY_VALUES,
        id: PLATFORM_AUDIT_POLICY_ID,
      })
      .onConflictDoNothing({ target: platformAuditPolicies.id })
      .returning();

    if (row) return row;

    const again = await this.get();
    if (!again) throw new Error('Failed to ensure platform_audit_policies singleton');
    return again;
  };

  get = async (): Promise<PlatformAuditPolicyItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAuditPolicies)
      .where(eq(platformAuditPolicies.id, PLATFORM_AUDIT_POLICY_ID))
      .limit(1);
    return row;
  };

  /**
   * Optimistic CAS update. Mismatch throws `PlatformRevisionConflictError`.
   */
  updateCAS = async (params: UpdatePlatformAuditPolicyParams): Promise<PlatformAuditPolicyItem> => {
    await this.getOrCreate();

    const run = async (db: LobeChatDatabase | Transaction) => {
      const [locked] = await db
        .select({ revision: platformAuditPolicies.revision })
        .from(platformAuditPolicies)
        .where(eq(platformAuditPolicies.id, PLATFORM_AUDIT_POLICY_ID))
        .limit(1)
        .for('update');

      if (!locked) throw new Error('platform_audit_policies row missing after getOrCreate');

      if (locked.revision !== params.expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Audit policy revision conflict: expectedRevision does not match current revision',
          {
            currentRevision: locked.revision,
            expectedRevision: params.expectedRevision,
            resourceId: PLATFORM_AUDIT_POLICY_ID,
            resourceType: 'audit_policy',
          },
        );
      }

      const nextRevision = locked.revision + 1;
      const patch: Partial<NewPlatformAuditPolicy> = {
        revision: nextRevision,
        updatedAt: new Date(),
        updatedBy: params.updatedBy ?? null,
      };

      if (params.operationLogRetentionDays !== undefined) {
        patch.operationLogRetentionDays = params.operationLogRetentionDays;
      }
      if (params.conversationRetentionDays !== undefined) {
        patch.conversationRetentionDays = params.conversationRetentionDays;
      }
      if (params.exportArtifactRetentionDays !== undefined) {
        patch.exportArtifactRetentionDays = params.exportArtifactRetentionDays;
      }
      if (params.contentAccessMode !== undefined) {
        patch.contentAccessMode = params.contentAccessMode;
      }
      if (params.messageBodyInExport !== undefined) {
        patch.messageBodyInExport = params.messageBodyInExport;
      }
      if (params.maxExportRows !== undefined) {
        patch.maxExportRows = params.maxExportRows;
      }
      if (params.maxListWindowDays !== undefined) {
        patch.maxListWindowDays = params.maxListWindowDays;
      }
      if (params.redactionProfile !== undefined) {
        patch.redactionProfile = params.redactionProfile;
      }

      const [row] = await db
        .update(platformAuditPolicies)
        .set(patch)
        .where(eq(platformAuditPolicies.id, PLATFORM_AUDIT_POLICY_ID))
        .returning();

      return row;
    };

    if ('transaction' in this.db) {
      return (this.db as LobeChatDatabase).transaction(async (tx) => run(tx));
    }
    return run(this.db);
  };
}
