/**
 * Admin user lifecycle mutations (create / ban / unban / delete).
 */
import { hashPassword } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { AdminUserModel } from '@/database/models/adminUser';
import { LastSuperAdminProtectionError, RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';
import { getGlobalRoleIdsByName } from '@/database/utils/seedPlatformRoles';
import { authEnv } from '@/envs/auth';
import { revokeOIDCArtifactsByUserId } from '@/libs/oidc-provider/access-control';

import type {
  AdminUsersBanInput,
  AdminUsersCreateInput,
  AdminUsersDeleteInput,
  AdminUsersUnbanInput,
} from '../../contracts/adminUsers';
import { LastSuperAdminError } from '../platformRbac';
import {
  AdminUserEmailConflictError,
  AdminUserNotFoundError,
  AdminUserPasswordAuthDisabledError,
  AdminUserSelfBanError,
  AdminUserSelfDeleteError,
  findUniqueViolation,
  generateEntityId,
} from './errors';
import { AdminUserSupport } from './support';

export class AdminUserLifecycleService extends AdminUserSupport {
  ban = async (params: { actorUserId: string; input: AdminUsersBanInput }) => {
    const { actorUserId, input } = params;

    if (input.userId === actorUserId) {
      // Denied audit outside any mutation txn (R2-03).
      await this.appendAuditBestEffort({
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

    const pre = await this.users.findBanState(input.userId);
    if (!pre) {
      await this.appendAuditBestEffort({
        action: 'admin.users.ban',
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
      const result = await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM rbac_roles WHERE name = ${PLATFORM_SYSTEM_ROLES.SUPER_ADMIN} AND workspace_id IS NULL FOR UPDATE`,
        );

        const model = new AdminUserModel(tx);
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
      throw error;
    }
  };

  unban = async (params: { actorUserId: string; input: AdminUsersUnbanInput }) => {
    const { actorUserId, input } = params;

    const pre = await this.users.findBanState(input.userId);
    if (!pre) {
      await this.appendAuditBestEffort({
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

    await this.db.transaction(async (tx) => {
      const model = new AdminUserModel(tx);
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

  createUser = async (params: { actorUserId: string; input: AdminUsersCreateInput }) => {
    const { actorUserId, input } = params;
    // Contract already trims + lowercases; email doubles as normalizedEmail.
    const email = input.email;

    // Email/password sign-in is disabled instance-wide — a credential user could
    // never log in. Reject before any write (mirrors the email-conflict path).
    if (authEnv.AUTH_DISABLE_EMAIL_PASSWORD) {
      await this.appendAuditBestEffort({
        action: 'admin.users.create',
        actorUserId,
        afterDiff: { error: 'password_auth_disabled' },
        reason: input.reason,
        result: 'failure',
        targetType: 'user',
      });
      throw new AdminUserPasswordAuthDisabledError();
    }

    const conflict = async (reasonCode: 'email_taken' | 'username_taken') => {
      await this.appendAuditBestEffort({
        action: 'admin.users.create',
        actorUserId,
        afterDiff: { error: reasonCode },
        reason: input.reason,
        result: 'failure',
        targetType: 'user',
      });
      return new AdminUserEmailConflictError(reasonCode);
    };

    if (await this.users.findUserIdByEmail(email)) {
      throw await conflict('email_taken');
    }

    // Hash outside the transaction (scrypt is CPU-bound); write-only material.
    const passwordHash = await hashPassword(input.password);

    try {
      const userId = await this.db.transaction(async (tx) => {
        const model = new AdminUserModel(tx);

        let newUserId = generateEntityId('user_');
        for (let attempt = 0; attempt < 5 && (await model.userIdExists(newUserId)); attempt += 1) {
          newUserId = generateEntityId('user_');
        }

        await model.createCredentialUser({
          accountId: generateEntityId('acct_'),
          email,
          fullName: input.fullName,
          normalizedEmail: email,
          passwordHash,
          userId: newUserId,
          username: input.username ?? null,
        });

        // Default global role for admin-created users (Authentik-only admission).
        const roleIdsByName = await getGlobalRoleIdsByName(tx, [
          PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
        ]);
        const roleIds = [roleIdsByName.get(PLATFORM_SYSTEM_ROLES.PLATFORM_USER)].filter(
          (id): id is string => Boolean(id),
        );
        const txRbac = new RbacModel(tx as LobeChatDatabase, actorUserId);
        await txRbac.replaceGlobalUserRoles(newUserId, roleIds, {
          preserveRoleNames: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
          protectLastSuperAdmin: true,
        });

        // NEVER put the password, its hash, or derived material in the audit row.
        await this.appendAuditInDb(tx, {
          action: 'admin.users.create',
          actorUserId,
          afterDiff: { created: true },
          reason: input.reason,
          result: 'success',
          targetId: newUserId,
          targetType: 'user',
        });

        return newUserId;
      });

      return { created: true as const, email, userId };
    } catch (error) {
      // Duplicate-check + insert race: map pg unique violations to the same error.
      const violation = findUniqueViolation(error);
      if (violation) {
        throw await conflict(
          violation.constraint.includes('username') ? 'username_taken' : 'email_taken',
        );
      }
      throw error;
    }
  };

  /**
   * Irreversible hard delete of a user and all FK-cascade owned data.
   * Blocks self-delete and the last permanent super admin. The audit row is written
   * inside the same transaction and survives (audit log ids are not FK-linked to users).
   */
  deleteUser = async (params: { actorUserId: string; input: AdminUsersDeleteInput }) => {
    const { actorUserId, input } = params;

    if (input.userId === actorUserId) {
      await this.appendAuditBestEffort({
        action: 'admin.users.delete',
        actorUserId,
        afterDiff: { error: 'self_delete' },
        reason: input.reason,
        result: 'denied',
        targetId: input.userId,
        targetType: 'user',
      });
      throw new AdminUserSelfDeleteError();
    }

    const pre = await this.users.findBanState(input.userId);
    if (!pre) {
      await this.appendAuditBestEffort({
        action: 'admin.users.delete',
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
      await this.db.transaction(async (tx) => {
        // Serialize with concurrent super-admin mutations (same lock as ban).
        await tx.execute(
          sql`SELECT id FROM rbac_roles WHERE name = ${PLATFORM_SYSTEM_ROLES.SUPER_ADMIN} AND workspace_id IS NULL FOR UPDATE`,
        );

        const model = new AdminUserModel(tx);
        const rbac = new RbacModel(tx as LobeChatDatabase, actorUserId);
        if (await rbac.isGlobalSuperAdmin(input.userId)) {
          const count = await rbac.countActiveSuperAdmins();
          if (count <= 1) throw new LastSuperAdminError();
        }

        // Audit before the cascade so intent is recorded even if delete throws.
        await this.appendAuditInDb(tx, {
          action: 'admin.users.delete',
          actorUserId,
          afterDiff: { deleted: true },
          reason: input.reason,
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });

        const ok = await model.hardDeleteUser(input.userId);
        if (!ok) throw new AdminUserNotFoundError();
      });

      try {
        await revokeOIDCArtifactsByUserId(this.db, input.userId);
      } catch {
        // User row is gone; residual OIDC artifacts are already orphaned.
      }

      await this.publishUserSecurityInvalidation(input.userId);

      return { deleted: true as const, userId: input.userId };
    } catch (error) {
      if (error instanceof LastSuperAdminError || error instanceof LastSuperAdminProtectionError) {
        await this.appendAuditBestEffort({
          action: 'admin.users.delete',
          actorUserId,
          afterDiff: { error: 'last_super_admin' },
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
          targetType: 'user',
        });
        throw error instanceof LastSuperAdminError ? error : new LastSuperAdminError();
      }
      throw error;
    }
  };
}
