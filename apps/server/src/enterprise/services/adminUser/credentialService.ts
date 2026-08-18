/**
 * Admin takeover of a user's sign-in factors (set password / disable 2FA).
 */
import { hashPassword } from 'better-auth/crypto';

import { AdminUserModel } from '@/database/models/adminUser';
import { revokeOIDCArtifactsByUserId } from '@/libs/oidc-provider/access-control';

import type {
  AdminUsersDisableTwoFactorInput,
  AdminUsersSetPasswordInput,
} from '../../contracts/adminUsers';
import {
  AdminUserNoCredentialAccountError,
  AdminUserNotFoundError,
  AdminUserSelfSetPasswordError,
} from './errors';
import { AdminUserSupport } from './support';

export class AdminUserCredentialService extends AdminUserSupport {
  setPassword = async (params: { actorUserId: string; input: AdminUsersSetPasswordInput }) => {
    const { actorUserId, input } = params;
    const revokeSessions = input.revokeSessions !== false;

    if (input.userId === actorUserId) {
      await this.auditUserFailure({
        action: 'admin.users.setPassword',
        actorUserId,
        error: 'self_set_password',
        result: 'denied',
        targetId: input.userId,
      });
      throw new AdminUserSelfSetPasswordError();
    }

    const exists = await this.users.findBanState(input.userId);
    if (!exists) {
      await this.auditUserFailure({
        action: 'admin.users.setPassword',
        actorUserId,
        error: 'not_found',
        result: 'failure',
        targetId: input.userId,
      });
      throw new AdminUserNotFoundError();
    }

    if (!(await this.users.hasCredentialAccount(input.userId))) {
      await this.auditUserFailure({
        action: 'admin.users.setPassword',
        actorUserId,
        error: 'no_credential_account',
        result: 'failure',
        targetId: input.userId,
      });
      throw new AdminUserNoCredentialAccountError();
    }

    // Hash outside the transaction (scrypt is CPU-bound); write-only material.
    const passwordHash = await hashPassword(input.newPassword);

    try {
      await this.db.transaction(async (tx) => {
        const model = new AdminUserModel(tx);
        const updated = await model.updateCredentialPassword({
          passwordHash,
          userId: input.userId,
        });
        if (!updated) throw new AdminUserNoCredentialAccountError();

        if (revokeSessions) {
          await model.revokeSessionsForUser({ userId: input.userId });
          await model.invalidateAuth({
            excludedSessionId: null,
            userId: input.userId,
          });
        }

        // NEVER put the password, its hash, or derived material in the audit row.
        await this.appendAuditInDb(tx, {
          action: 'admin.users.setPassword',
          actorUserId,
          afterDiff: { sessionsRevoked: revokeSessions },
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });
      });
    } catch (error) {
      if (error instanceof AdminUserNoCredentialAccountError) {
        await this.auditUserFailure({
          action: 'admin.users.setPassword',
          actorUserId,
          error: 'no_credential_account',
          result: 'failure',
          targetId: input.userId,
        });
      }
      throw error;
    }

    if (revokeSessions) {
      try {
        await revokeOIDCArtifactsByUserId(this.db, input.userId);
      } catch {
        // best-effort; authInvalidatedAt already advanced
      }
      await this.publishUserSecurityInvalidation(input.userId);
    }

    return { sessionsRevoked: revokeSessions, userId: input.userId };
  };

  disableTwoFactor = async (params: {
    actorUserId: string;
    input: AdminUsersDisableTwoFactorInput;
  }) => {
    const { actorUserId, input } = params;
    const removePasskeys = Boolean(input.removePasskeys);

    const exists = await this.users.findBanState(input.userId);
    if (!exists) {
      await this.auditUserFailure({
        action: 'admin.users.disableTwoFactor',
        actorUserId,
        error: 'not_found',
        result: 'failure',
        targetId: input.userId,
      });
      throw new AdminUserNotFoundError();
    }

    await this.db.transaction(async (tx) => {
      const model = new AdminUserModel(tx);
      const twoFactorDeleted = await model.deleteTwoFactorForUser(input.userId);
      const passkeysDeleted = removePasskeys ? await model.deletePasskeysForUser(input.userId) : 0;

      await model.setTwoFactorEnabled({ enabled: false, userId: input.userId });
      await model.revokeSessionsForUser({ userId: input.userId });
      await model.invalidateAuth({
        excludedSessionId: null,
        userId: input.userId,
      });

      await this.appendAuditInDb(tx, {
        action: 'admin.users.disableTwoFactor',
        actorUserId,
        afterDiff: {
          passkeysDeleted,
          passkeysRemoved: removePasskeys,
          twoFactorDeleted,
          twoFactorEnabled: false,
        },
        result: 'success',
        targetId: input.userId,
        targetType: 'user',
      });
    });

    try {
      await revokeOIDCArtifactsByUserId(this.db, input.userId);
    } catch {
      // best-effort; authInvalidatedAt already advanced
    }

    await this.publishUserSecurityInvalidation(input.userId);

    return {
      passkeysRemoved: removePasskeys,
      twoFactorEnabled: false as const,
      userId: input.userId,
    };
  };
}
