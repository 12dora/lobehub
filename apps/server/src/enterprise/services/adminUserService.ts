/**
 * Admin user management service (M04).
 * Orchestrates AdminUserModel + PlatformRbacService + atomic audit + auth invalidation.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { AdminUserModel } from '@/database/models/adminUser';
import {
  type CreatePlatformAuditLogParams,
  PlatformAuditLogModel,
} from '@/database/models/platform';
import { LastSuperAdminProtectionError, RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase, Transaction } from '@/database/type';
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

/** One-way fingerprint of search text — never store full query. */
export const fingerprintQuery = (query: string | undefined): string | null => {
  if (!query) return null;
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
};

export class AdminUserService {
  private readonly users: AdminUserModel;
  private readonly rbacService: PlatformRbacService;
  private readonly invalidation: PlatformConfigInvalidationPublisher;

  constructor(
    private readonly db: LobeChatDatabase,
    options?: {
      invalidation?: PlatformConfigInvalidationPublisher;
    },
  ) {
    this.users = new AdminUserModel(db);
    this.rbacService = new PlatformRbacService(db);
    this.invalidation = options?.invalidation ?? getPlatformConfigInvalidationPublisher();
  }

  list = async (input: AdminUsersListInputParsed, meta?: { actorUserId?: string }) => {
    const result = await this.users.list({
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      cursor: input.cursor,
      limit: input.limit,
      query: input.query,
      role: input.role,
      status: input.status,
    });

    // Access audit: filter classes only — never full query text.
    await this.appendAuditBestEffort({
      action: 'admin.users.list',
      actorUserId: meta?.actorUserId,
      afterDiff: {
        filterClasses: {
          hasCreatedRange: Boolean(input.createdFrom || input.createdTo),
          hasCursor: Boolean(input.cursor),
          hasQuery: Boolean(input.query),
          hasRole: Boolean(input.role),
          hasStatus: Boolean(input.status),
          queryFingerprint: fingerprintQuery(input.query),
        },
        itemCount: result.items.length,
      },
      result: 'success',
      targetType: 'user_list',
    });

    return result;
  };

  get = async (userId: string, meta?: { actorUserId?: string }) => {
    const detail = await this.users.findDetailById(userId);
    if (!detail) throw new AdminUserNotFoundError();

    await this.appendAuditBestEffort({
      action: 'admin.users.get',
      actorUserId: meta?.actorUserId,
      result: 'success',
      targetId: userId,
      targetType: 'user',
    });

    return detail;
  };

  getAuditTrail = async (input: AdminUsersGetAuditTrailInputParsed) => {
    const exists = await this.users.findBanState(input.userId);
    if (!exists) throw new AdminUserNotFoundError();

    const model = new PlatformAuditLogModel(this.db);
    const result = await model.list({
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
      await this.appendAuditInDb(this.db, {
        action: 'admin.users.ban',
        actorUserId,
        afterDiff: { error: 'self_ban' },
        reason: input.reason,
        result: 'denied',
        targetId: input.userId,
        targetType: 'user',
      });
      throw new AdminUserSelfBanError();
    }

    try {
      const result = await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM rbac_roles WHERE name = ${PLATFORM_SYSTEM_ROLES.SUPER_ADMIN} AND workspace_id IS NULL FOR UPDATE`,
        );

        const model = new AdminUserModel(tx);
        const target = await model.findBanState(input.userId);
        if (!target) throw new AdminUserNotFoundError();

        const rbac = new RbacModel(tx as LobeChatDatabase, actorUserId);
        if (await rbac.isGlobalSuperAdmin(input.userId)) {
          const count = await rbac.countActiveSuperAdmins();
          if (count <= 1) throw new LastSuperAdminError();
        }

        const updated = await model.setBanned({
          banExpires: input.expiresAt ?? null,
          banReason: input.reason,
          banned: true,
          invalidateAuth: true,
          userId: input.userId,
        });
        if (!updated) throw new AdminUserNotFoundError();

        await model.revokeSessionsForUser({ userId: input.userId });

        await this.appendAuditInDb(tx, {
          action: 'admin.users.ban',
          actorUserId,
          afterDiff: {
            banExpires: updated.banExpires?.toISOString() ?? null,
            banned: true,
          },
          reason: input.reason,
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });

        return updated;
      });

      try {
        await revokeOIDCArtifactsByUserId(this.db, input.userId);
      } catch {
        // ban+audit committed; OIDC JWT still rejected via authInvalidatedAt
      }

      await this.publishUserSecurityInvalidation(input.userId);

      return {
        banExpires: result.banExpires ?? null,
        banned: true as const,
        userId: input.userId,
      };
    } catch (error) {
      if (error instanceof LastSuperAdminError || error instanceof LastSuperAdminProtectionError) {
        await this.appendAuditBestEffort({
          action: 'admin.users.ban',
          actorUserId,
          afterDiff: { error: 'last_super_admin' },
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
          targetType: 'user',
        });
        throw error instanceof LastSuperAdminError ? error : new LastSuperAdminError();
      }
      if (error instanceof AdminUserNotFoundError) {
        await this.appendAuditBestEffort({
          action: 'admin.users.ban',
          actorUserId,
          afterDiff: { error: 'not_found' },
          reason: input.reason,
          result: 'failure',
          targetId: input.userId,
          targetType: 'user',
        });
      }
      throw error;
    }
  };

  unban = async (params: { actorUserId: string; input: AdminUsersUnbanInput }) => {
    const { actorUserId, input } = params;

    await this.db.transaction(async (tx) => {
      const model = new AdminUserModel(tx);
      const target = await model.findBanState(input.userId);
      if (!target) {
        await this.appendAuditInDb(tx, {
          action: 'admin.users.unban',
          actorUserId,
          afterDiff: { error: 'not_found' },
          reason: input.reason,
          result: 'failure',
          targetId: input.userId,
          targetType: 'user',
        });
        throw new AdminUserNotFoundError();
      }

      await model.setBanned({
        banReason: input.reason,
        banned: false,
        userId: input.userId,
      });

      await this.appendAuditInDb(tx, {
        action: 'admin.users.unban',
        actorUserId,
        afterDiff: { banned: false },
        reason: input.reason,
        result: 'success',
        targetId: input.userId,
        targetType: 'user',
      });
    });

    return { banned: false as const, userId: input.userId };
  };

  revokeSessions = async (params: {
    actorSessionId?: string | null;
    actorUserId: string;
    input: AdminUsersRevokeSessionsInput;
  }) => {
    const { actorUserId, actorSessionId, input } = params;

    const revokedCount = await this.db.transaction(async (tx) => {
      const model = new AdminUserModel(tx);
      const target = await model.findBanState(input.userId);
      if (!target) {
        await this.appendAuditInDb(tx, {
          action: 'admin.users.revokeSessions',
          actorUserId,
          afterDiff: { error: 'not_found' },
          reason: input.reason,
          result: 'failure',
          targetId: input.userId,
          targetType: 'user',
        });
        throw new AdminUserNotFoundError();
      }

      const excludeSessionId =
        !input.includeCurrent && actorSessionId && input.userId === actorUserId
          ? actorSessionId
          : undefined;

      const count = await model.revokeSessionsForUser({
        excludeSessionId,
        userId: input.userId,
      });

      await model.invalidateAuth(input.userId);

      await this.appendAuditInDb(tx, {
        action: 'admin.users.revokeSessions',
        actorUserId,
        afterDiff: {
          includeCurrent: Boolean(input.includeCurrent),
          revokedCount: count,
        },
        reason: input.reason,
        result: 'success',
        targetId: input.userId,
        targetType: 'user',
      });

      return count;
    });

    try {
      await revokeOIDCArtifactsByUserId(this.db, input.userId);
    } catch {
      // best-effort; authInvalidatedAt already advanced
    }

    await this.publishUserSecurityInvalidation(input.userId);

    return { revokedCount, userId: input.userId };
  };

  replaceGlobalRoles = async (params: {
    actorUserId: string;
    input: AdminUsersReplaceGlobalRolesInput;
  }) => {
    const { actorUserId, input } = params;

    // Permanent super_admin policy — reject any finite expiresAt with super_admin.
    if (input.expiresAt && input.roleNames.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN)) {
      await this.appendAuditBestEffort({
        action: 'admin.users.replaceGlobalRoles',
        actorUserId,
        afterDiff: { error: 'super_admin_expires_forbidden' },
        reason: input.reason,
        result: 'denied',
        targetId: input.userId,
        targetType: 'user',
      });
      throw new Error(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    }

    const target = await this.users.findBanState(input.userId);
    if (!target) {
      await this.appendAuditBestEffort({
        action: 'admin.users.replaceGlobalRoles',
        actorUserId,
        afterDiff: { error: 'not_found' },
        reason: input.reason,
        result: 'failure',
        targetId: input.userId,
        targetType: 'user',
      });
      throw new AdminUserNotFoundError();
    }

    try {
      // Role replace (inner txn/savepoint) + both audit rows in one outer transaction.
      // If either audit append fails, the whole unit rolls back.
      const result = await this.db.transaction(async (tx) => {
        const rbacService = new PlatformRbacService(tx as LobeChatDatabase);
        const replaced = await rbacService.replaceUserGlobalRoles({
          actorUserId,
          expiresAt: input.expiresAt,
          reason: input.reason,
          roleNames: input.roleNames,
          skipAudit: true,
          targetUserId: input.userId,
        });

        await this.appendAuditInDb(tx, {
          action: 'platform.roles.replace',
          actorUserId,
          afterDiff: {
            expiresAt: input.expiresAt?.toISOString() ?? null,
            roleNames: replaced.roleNames,
          },
          reason: input.reason,
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });

        await this.appendAuditInDb(tx, {
          action: 'admin.users.replaceGlobalRoles',
          actorUserId,
          afterDiff: {
            expiresAt: input.expiresAt?.toISOString() ?? null,
            roleNames: replaced.roleNames,
          },
          reason: input.reason,
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });

        return replaced;
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
          (error.message === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED ||
            error.message === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT ||
            error.message === 'PLATFORM_INVALID_INPUT'))
      ) {
        await this.appendAuditBestEffort({
          action: 'admin.users.replaceGlobalRoles',
          actorUserId,
          afterDiff: {
            error:
              error instanceof Error &&
              error.message === PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED
                ? 'permission_denied'
                : error instanceof LastSuperAdminError ||
                    error instanceof LastSuperAdminProtectionError
                  ? 'last_super_admin'
                  : 'invalid_input',
          },
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
          targetType: 'user',
        });
      }
      if (error instanceof Error && error.message === 'PLATFORM_INVALID_INPUT') {
        throw new Error(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT, { cause: error });
      }
      throw error;
    }
  };

  /** Record denied reauth for high-risk mutations (router-level). */
  recordReauthDenied = async (params: {
    action: string;
    actorUserId: string;
    reason?: string;
    targetId?: string;
  }) => {
    await this.appendAuditBestEffort({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: { error: 'reauth_required' },
      reason: params.reason ?? null,
      result: 'denied',
      targetId: params.targetId,
      targetType: 'user',
    });
  };

  private appendAuditInDb = async (
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
  private appendAuditBestEffort = async (params: CreatePlatformAuditLogParams) => {
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

  private publishUserSecurityInvalidation = async (userId: string) => {
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

export type AdminUserMutationAuth = {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod | null;
  sessionId?: string | null;
  userId: string;
};
