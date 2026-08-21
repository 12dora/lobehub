/**
 * Admin user lifecycle mutations (create / ban / unban / delete).
 */
import { hashPassword } from 'better-auth/crypto';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { AdminUserModel } from '@/database/models/adminUser';
import { PlatformContentModerationRecordModel } from '@/database/models/platform/contentModerationRecords';
import { LastSuperAdminProtectionError, RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';
import { getGlobalRoleIdsByName } from '@/database/utils/seedPlatformRoles';
import { revokeOIDCArtifactsByUserId } from '@/libs/oidc-provider/access-control';

import type {
  AdminUsersBanInput,
  AdminUsersCreateInput,
  AdminUsersDeleteInput,
  AdminUsersUnbanInput,
} from '../../contracts/adminUsers';
import { CONTENT_MODERATION_AUDIT_ACTIONS } from '../contentModeration/constants';
import { LastSuperAdminError } from '../platformRbac';
import {
  AdminUserEmailConflictError,
  AdminUserNotFoundError,
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
      await this.auditUserFailure({
        action: 'admin.users.ban',
        actorUserId,
        error: 'self_ban',
        reason: input.reason,
        result: 'denied',
        targetId: input.userId,
      });
      throw new AdminUserSelfBanError();
    }

    const pre = await this.users.findBanState(input.userId);
    if (!pre) {
      await this.auditUserFailure({
        action: 'admin.users.ban',
        actorUserId,
        error: 'not_found',
        reason: input.reason,
        result: 'failure',
        targetId: input.userId,
      });
      throw new AdminUserNotFoundError();
    }

    try {
      const result = await this.db.transaction(async (tx) => {
        await this.lockSuperAdminRoleRow(tx);

        const model = new AdminUserModel(tx);
        await this.assertNotLastSuperAdmin(tx, actorUserId, input.userId, { mode: 'last' });

        const updated = await model.setBanned({
          banExpires: input.expiresAt ?? null,
          banReason: input.reason,
          banned: true,
          invalidateAuth: true,
          userId: input.userId,
        });
        if (!updated) throw new AdminUserNotFoundError();

        const { tokens } = await model.revokeAuthSessions({ userId: input.userId });

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

        return { tokens, updated };
      });

      await this.evictBetterAuthSecondaryStorage(result.tokens);

      try {
        await revokeOIDCArtifactsByUserId(this.db, input.userId);
      } catch {
        // ban+audit committed; OIDC JWT still rejected via authInvalidatedAt
      }

      await this.publishUserSecurityInvalidation(input.userId);

      return {
        banExpires: result.updated.banExpires ?? null,
        banned: true as const,
        userId: input.userId,
      };
    } catch (error) {
      if (error instanceof LastSuperAdminError || error instanceof LastSuperAdminProtectionError) {
        await this.auditUserFailure({
          action: 'admin.users.ban',
          actorUserId,
          error: 'last_super_admin',
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
        });
        throw error instanceof LastSuperAdminError ? error : new LastSuperAdminError();
      }
      throw error;
    }
  };

  /**
   * System-actor ban used by content-moderation auto-ban.
   *
   * Same transactional shape as {@link ban}: role lock, refuse any `super_admin`,
   * setBanned + session revoke + mark the triggering record + audit. OIDC
   * artefacts are revoked after commit. An audit-append failure rolls the ban back.
   */
  systemBan = async (params: { input: AdminUsersBanInput; recordId: string }) => {
    const { input, recordId } = params;
    const actorUserId = 'system:content-moderation';

    const pre = await this.users.findBanState(input.userId);
    if (!pre) throw new AdminUserNotFoundError();

    try {
      const result = await this.db.transaction(async (tx) => {
        await this.lockSuperAdminRoleRow(tx);

        const model = new AdminUserModel(tx);
        await this.assertNotLastSuperAdmin(tx, actorUserId, input.userId, { mode: 'any' });

        const updated = await model.setBanned({
          banExpires: input.expiresAt ?? null,
          banReason: input.reason,
          banned: true,
          invalidateAuth: true,
          userId: input.userId,
        });
        if (!updated) throw new AdminUserNotFoundError();

        const { tokens } = await model.revokeAuthSessions({ userId: input.userId });
        await new PlatformContentModerationRecordModel(tx).markAutoBanned(recordId);

        await this.appendAuditInDb(tx, {
          action: CONTENT_MODERATION_AUDIT_ACTIONS.USER_AUTO_BAN,
          actorUserId: null,
          afterDiff: {
            banExpires: updated.banExpires?.toISOString() ?? null,
            banned: true,
          },
          reason: input.reason,
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });

        return { tokens, updated };
      });

      await this.evictBetterAuthSecondaryStorage(result.tokens);

      try {
        await revokeOIDCArtifactsByUserId(this.db, input.userId);
      } catch {
        // ban+audit committed; OIDC JWT still rejected via authInvalidatedAt
      }

      await this.publishUserSecurityInvalidation(input.userId);

      return {
        banExpires: result.updated.banExpires ?? null,
        banned: true as const,
        userId: input.userId,
      };
    } catch (error) {
      if (error instanceof LastSuperAdminError || error instanceof LastSuperAdminProtectionError) {
        await this.auditUserFailure({
          action: CONTENT_MODERATION_AUDIT_ACTIONS.USER_AUTO_BAN,
          actorUserId: null,
          error: 'last_super_admin',
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
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
      await this.auditUserFailure({
        action: 'admin.users.unban',
        actorUserId,
        error: 'not_found',
        reason: input.reason,
        result: 'failure',
        targetId: input.userId,
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
    await this.assertPasswordAuthEnabled({
      action: 'admin.users.create',
      actorUserId,
      reason: input.reason,
    });

    const conflict = async (reasonCode: 'email_taken' | 'username_taken') => {
      await this.auditUserFailure({
        action: 'admin.users.create',
        actorUserId,
        error: reasonCode,
        reason: input.reason,
        result: 'failure',
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
      await this.auditUserFailure({
        action: 'admin.users.delete',
        actorUserId,
        error: 'self_delete',
        reason: input.reason,
        result: 'denied',
        targetId: input.userId,
      });
      throw new AdminUserSelfDeleteError();
    }

    const pre = await this.users.findBanState(input.userId);
    if (!pre) {
      await this.auditUserFailure({
        action: 'admin.users.delete',
        actorUserId,
        error: 'not_found',
        reason: input.reason,
        result: 'failure',
        targetId: input.userId,
      });
      throw new AdminUserNotFoundError();
    }

    try {
      const { tokens } = await this.db.transaction(async (tx) => {
        // Serialize with concurrent super-admin mutations (same lock as ban).
        await this.lockSuperAdminRoleRow(tx);

        const model = new AdminUserModel(tx);
        await this.assertNotLastSuperAdmin(tx, actorUserId, input.userId, { mode: 'last' });

        // Capture session tokens before the user cascade so Redis can be evicted.
        const { tokens } = await model.revokeAuthSessions({ userId: input.userId });

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
        return { tokens };
      });

      await this.evictBetterAuthSecondaryStorage(tokens);

      try {
        await revokeOIDCArtifactsByUserId(this.db, input.userId);
      } catch {
        // User row is gone; residual OIDC artifacts are already orphaned.
      }

      await this.publishUserSecurityInvalidation(input.userId);

      return { deleted: true as const, userId: input.userId };
    } catch (error) {
      if (error instanceof LastSuperAdminError || error instanceof LastSuperAdminProtectionError) {
        await this.auditUserFailure({
          action: 'admin.users.delete',
          actorUserId,
          error: 'last_super_admin',
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
        });
        throw error instanceof LastSuperAdminError ? error : new LastSuperAdminError();
      }
      throw error;
    }
  };
}
