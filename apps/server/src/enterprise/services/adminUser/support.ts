/**
 * Shared audit + security-invalidation helpers for admin user services.
 */
import { AdminUserModel } from '@/database/models/adminUser';
import {
  type CreatePlatformAuditLogParams,
  PlatformAuditLogModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { PlatformRbacService } from '../platformRbac';

export class AdminUserSupport {
  readonly users: AdminUserModel;
  readonly rbacService: PlatformRbacService;
  readonly invalidation: PlatformConfigInvalidationPublisher;

  constructor(
    readonly db: LobeChatDatabase,
    options?: {
      invalidation?: PlatformConfigInvalidationPublisher;
    },
  ) {
    this.users = new AdminUserModel(db);
    this.rbacService = new PlatformRbacService(db);
    this.invalidation = options?.invalidation ?? getPlatformConfigInvalidationPublisher();
  }

  appendAuditInDb = async (
    db: LobeChatDatabase | Transaction,
    params: CreatePlatformAuditLogParams,
  ) => {
    const model = new PlatformAuditLogModel(db);
    return model.append(params);
  };

  /**
   * Best-effort audit outside a mutation txn. Logs redacted operational signal on failure
   * — does not swallow silently.
   */
  appendAuditBestEffort = async (params: CreatePlatformAuditLogParams) => {
    try {
      await this.appendAuditInDb(this.db, params);
    } catch (error) {
      // Redacted operational signal — never log secrets/query text.
      console.error('[platform-audit] append failed', {
        action: params.action,
        result: params.result,
        targetType: params.targetType,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  };

  publishUserSecurityInvalidation = async (userId: string) => {
    try {
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: userId,
        resourceType: 'user_security',
        revision: Date.now(),
        scopes: ['auth_sessions', 'user_ban', 'auth_invalidated_at'],
      });
    } catch {
      // Best-effort secondary signal; DB authInvalidatedAt is source of truth.
    }
  };
}
