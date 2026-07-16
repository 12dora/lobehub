/**
 * Admin user management service (M04).
 * Orchestrates AdminUserModel + PlatformRbacService + audit + session invalidation.
 */
import { sql } from 'drizzle-orm';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { AdminUserModel } from '@/database/models/adminUser';
import { LastSuperAdminProtectionError, RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';
import { revokeOIDCArtifactsByUserId } from '@/libs/oidc-provider/access-control';
import type { AuthMethod } from '@/libs/trpc/lambda/context';

import type {
  AdminUsersBanInput,
  AdminUsersGetAuditTrailInputParsed,
  AdminUsersListInputParsed,
  AdminUsersReplaceGlobalRolesInput,
  AdminUsersRevokeSessionsInput,
  AdminUsersUnbanInput,
} from '../contracts/adminUsers';
import { PlatformAuditService } from './platformAudit';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from './platformConfigInvalidation';
import { LastSuperAdminError, PlatformRbacService } from './platformRbac';

export class AdminUserNotFoundError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND;

  constructor(message = PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND) {
    super(message);
    this.name = 'AdminUserNotFoundError';
  }
}

export class AdminUserSelfBanError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;

  constructor(message = 'Cannot ban yourself') {
    super(message);
    this.name = 'AdminUserSelfBanError';
  }
}

export class AdminUserService {
  private readonly users: AdminUserModel;
  private readonly rbacService: PlatformRbacService;
  private readonly audit: PlatformAuditService;
  private readonly invalidation: PlatformConfigInvalidationPublisher;

  constructor(
    private readonly db: LobeChatDatabase,
    options?: {
      invalidation?: PlatformConfigInvalidationPublisher;
    },
  ) {
    this.users = new AdminUserModel(db);
    this.rbacService = new PlatformRbacService(db);
    this.audit = new PlatformAuditService(db);
    this.invalidation = options?.invalidation ?? getPlatformConfigInvalidationPublisher();
  }

  list = async (input: AdminUsersListInputParsed) => {
    return this.users.list({
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      cursor: input.cursor,
      limit: input.limit,
      query: input.query,
      role: input.role,
      status: input.status,
    });
  };

  get = async (userId: string) => {
    const detail = await this.users.findDetailById(userId);
    if (!detail) throw new AdminUserNotFoundError();
    return detail;
  };

  getAuditTrail = async (input: AdminUsersGetAuditTrailInputParsed) => {
    const exists = await this.users.findBanState(input.userId);
    if (!exists) throw new AdminUserNotFoundError();

    const result = await this.audit.list({
      cursor: input.cursor,
      limit: input.limit,
      targetId: input.userId,
      targetType: 'user',
    });

    return {
      items: result.items.map((row) => ({
        action: row.action,
        actorUserId: row.actorUserId,
        createdAt: row.createdAt,
        id: row.id,
        reason: row.reason,
        result: row.result,
        targetId: row.targetId,
        targetType: row.targetType,
      })),
      nextCursor: result.nextCursor,
    };
  };

  ban = async (params: { actorUserId: string; input: AdminUsersBanInput }) => {
    const { actorUserId, input } = params;

    if (input.userId === actorUserId) {
      await this.auditFailure({
        action: 'admin.users.ban',
        actorUserId,
        reason: input.reason,
        result: 'denied',
        targetId: input.userId,
        afterDiff: { error: 'self_ban' },
      });
      throw new AdminUserSelfBanError();
    }

    try {
      const result = await this.db.transaction(async (tx) => {
        // Serialize last-super checks with demotions (TOCTOU).
        await tx.execute(
          sql`SELECT id FROM rbac_roles WHERE name = ${PLATFORM_SYSTEM_ROLES.SUPER_ADMIN} AND workspace_id IS NULL FOR UPDATE`,
        );

        const model = new AdminUserModel(tx);
        const target = await model.findBanState(input.userId);
        if (!target) throw new AdminUserNotFoundError();

        const rbac = new RbacModel(tx as LobeChatDatabase, actorUserId);
        const isTargetSuper = await rbac.isGlobalSuperAdmin(input.userId);
        if (isTargetSuper) {
          const count = await rbac.countActiveSuperAdmins();
          if (count <= 1) {
            throw new LastSuperAdminError();
          }
        }

        const updated = await model.setBanned({
          banExpires: input.expiresAt ?? null,
          banReason: input.reason,
          banned: true,
          userId: input.userId,
        });
        if (!updated) throw new AdminUserNotFoundError();

        await model.revokeSessionsForUser({ userId: input.userId });

        return updated;
      });

      // Best-effort OIDC artifact cleanup outside the ban transaction.
      try {
        await revokeOIDCArtifactsByUserId(this.db, input.userId);
      } catch {
        // ignore — ban already committed; JWT path still rejects via assertUserActive
      }

      await this.publishUserSecurityInvalidation(input.userId);

      await this.audit.append({
        action: 'admin.users.ban',
        actorUserId,
        afterDiff: {
          banExpires: result.banExpires?.toISOString() ?? null,
          banned: true,
        },
        reason: input.reason,
        result: 'success',
        targetId: input.userId,
        targetType: 'user',
      });

      return {
        banExpires: result.banExpires ?? null,
        banned: true as const,
        userId: input.userId,
      };
    } catch (error) {
      if (error instanceof LastSuperAdminError || error instanceof LastSuperAdminProtectionError) {
        await this.auditFailure({
          action: 'admin.users.ban',
          actorUserId,
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
          afterDiff: { error: 'last_super_admin' },
        });
        throw error instanceof LastSuperAdminError ? error : new LastSuperAdminError();
      }
      if (error instanceof AdminUserNotFoundError) {
        await this.auditFailure({
          action: 'admin.users.ban',
          actorUserId,
          reason: input.reason,
          result: 'failure',
          targetId: input.userId,
          afterDiff: { error: 'not_found' },
        });
      }
      throw error;
    }
  };

  unban = async (params: { actorUserId: string; input: AdminUsersUnbanInput }) => {
    const { actorUserId, input } = params;
    const target = await this.users.findBanState(input.userId);
    if (!target) {
      await this.auditFailure({
        action: 'admin.users.unban',
        actorUserId,
        reason: input.reason,
        result: 'failure',
        targetId: input.userId,
        afterDiff: { error: 'not_found' },
      });
      throw new AdminUserNotFoundError();
    }

    await this.users.setBanned({
      banReason: input.reason,
      banned: false,
      userId: input.userId,
    });

    await this.audit.append({
      action: 'admin.users.unban',
      actorUserId,
      afterDiff: { banned: false },
      reason: input.reason,
      result: 'success',
      targetId: input.userId,
      targetType: 'user',
    });

    return { banned: false as const, userId: input.userId };
  };

  revokeSessions = async (params: {
    actorSessionId?: string | null;
    actorUserId: string;
    input: AdminUsersRevokeSessionsInput;
  }) => {
    const { actorUserId, actorSessionId, input } = params;
    const target = await this.users.findBanState(input.userId);
    if (!target) {
      await this.auditFailure({
        action: 'admin.users.revokeSessions',
        actorUserId,
        reason: input.reason,
        result: 'failure',
        targetId: input.userId,
        afterDiff: { error: 'not_found' },
      });
      throw new AdminUserNotFoundError();
    }

    const excludeSessionId =
      !input.includeCurrent && actorSessionId && input.userId === actorUserId
        ? actorSessionId
        : undefined;

    const revokedCount = await this.users.revokeSessionsForUser({
      excludeSessionId,
      userId: input.userId,
    });

    try {
      await revokeOIDCArtifactsByUserId(this.db, input.userId);
    } catch {
      // best-effort
    }

    await this.publishUserSecurityInvalidation(input.userId);

    await this.audit.append({
      action: 'admin.users.revokeSessions',
      actorUserId,
      afterDiff: {
        includeCurrent: Boolean(input.includeCurrent),
        revokedCount,
      },
      reason: input.reason,
      result: 'success',
      targetId: input.userId,
      targetType: 'user',
    });

    return { revokedCount, userId: input.userId };
  };

  replaceGlobalRoles = async (params: {
    actorUserId: string;
    input: AdminUsersReplaceGlobalRolesInput;
  }) => {
    const { actorUserId, input } = params;
    const target = await this.users.findBanState(input.userId);
    if (!target) {
      await this.auditFailure({
        action: 'admin.users.replaceGlobalRoles',
        actorUserId,
        reason: input.reason,
        result: 'failure',
        targetId: input.userId,
        afterDiff: { error: 'not_found' },
      });
      throw new AdminUserNotFoundError();
    }

    try {
      const result = await this.rbacService.replaceUserGlobalRoles({
        actorUserId,
        expiresAt: input.expiresAt,
        reason: input.reason,
        roleNames: input.roleNames,
        targetUserId: input.userId,
      });

      return {
        expiresAt: input.expiresAt ?? null,
        roleNames: result.roleNames,
        userId: input.userId,
      };
    } catch (error) {
      if (
        error instanceof LastSuperAdminError ||
        error instanceof LastSuperAdminProtectionError ||
        (error instanceof Error &&
          error.message === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED)
      ) {
        await this.auditFailure({
          action: 'admin.users.replaceGlobalRoles',
          actorUserId,
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
          afterDiff: {
            error:
              error instanceof Error &&
              error.message === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED
                ? 'permission_denied'
                : 'last_super_admin',
          },
        });
      }
      throw error;
    }
  };

  private publishUserSecurityInvalidation = async (userId: string) => {
    try {
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: userId,
        resourceType: 'user_security',
        revision: Date.now(),
        scopes: ['auth_sessions', 'user_ban'],
      });
    } catch {
      // Best-effort only — no multi-instance guarantee invented here.
    }
  };

  private auditFailure = async (params: {
    action: string;
    actorUserId: string;
    afterDiff?: Record<string, unknown>;
    reason: string;
    result: 'failure' | 'denied';
    targetId: string;
  }) => {
    try {
      await this.audit.append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: params.afterDiff,
        reason: params.reason,
        result: params.result,
        targetId: params.targetId,
        targetType: 'user',
      });
    } catch {
      // never block primary error path on audit write failure
    }
  };
}

/** Context slice required for high-risk mutations. */
export type AdminUserMutationAuth = {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod | null;
  sessionId?: string | null;
  userId: string;
};
