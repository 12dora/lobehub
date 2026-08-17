/**
 * Shared audit + security-invalidation helpers for admin user services.
 */
import { sql } from 'drizzle-orm';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { AdminUserModel } from '@/database/models/adminUser';
import {
  type CreatePlatformAuditLogParams,
  PlatformAuditLogModel,
} from '@/database/models/platform';
import { RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { LastSuperAdminError, PlatformRbacService } from '../platformRbac';

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

  protected auditUserFailure = async (params: {
    action: string;
    actorUserId?: string | null;
    error: string;
    extra?: Record<string, unknown>;
    reason?: string | null;
    result: 'denied' | 'failure';
    targetId?: string | null;
  }) => {
    const { action, actorUserId, error, extra, reason, result, targetId } = params;
    await this.appendAuditBestEffort({
      action,
      actorUserId,
      afterDiff: { error, ...extra },
      reason,
      result,
      targetId,
      targetType: 'user',
    });
  };

  protected lockSuperAdminRoleRow = async (tx: Transaction) => {
    await tx.execute(
      sql`SELECT id FROM rbac_roles WHERE name = ${PLATFORM_SYSTEM_ROLES.SUPER_ADMIN} AND workspace_id IS NULL FOR UPDATE`,
    );
  };

  /**
   * `mode: 'last'` refuses only the last remaining super admin.
   * `mode: 'any'` refuses every super admin (systemBan).
   */
  protected assertNotLastSuperAdmin = async (
    tx: Transaction,
    actorUserId: string,
    targetUserId: string,
    options: { mode: 'any' | 'last' },
  ) => {
    const rbac = new RbacModel(tx as LobeChatDatabase, actorUserId);
    if (!(await rbac.isGlobalSuperAdmin(targetUserId))) return;
    if (options.mode === 'any') throw new LastSuperAdminError();
    const count = await rbac.countActiveSuperAdmins();
    if (count <= 1) throw new LastSuperAdminError();
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
