/**
 * Admin user management service (M04).
 * Orchestrates AdminUserModel + PlatformRbacService + atomic audit + auth invalidation.
 */
import { createHash, randomBytes } from 'node:crypto';

import { hashPassword } from 'better-auth/crypto';
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
import { getGlobalRoleIdsByName } from '@/database/utils/seedPlatformRoles';
import { authEnv } from '@/envs/auth';
import { revokeOIDCArtifactsByUserId } from '@/libs/oidc-provider/access-control';
import type { AuthMethod } from '@/libs/trpc/lambda/context';

import type {
  AdminUsersBanInput,
  AdminUsersCreateInput,
  AdminUsersDeleteInput,
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

export class AdminUserSelfDeleteError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;

  constructor(message = 'Cannot delete yourself') {
    super(message);
    this.name = 'AdminUserSelfDeleteError';
  }
}

/**
 * Duplicate email (or username) on admin credential-user create.
 * Maps to public PLATFORM_INVALID_INPUT with a machine-readable reason.
 */
export class AdminUserEmailConflictError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
  readonly reasonCode: 'email_taken' | 'username_taken';

  constructor(reasonCode: 'email_taken' | 'username_taken' = 'email_taken') {
    super(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    this.name = 'AdminUserEmailConflictError';
    this.reasonCode = reasonCode;
  }
}

/**
 * Email/password auth is disabled instance-wide (AUTH_DISABLE_EMAIL_PASSWORD),
 * so an admin-provisioned credential user could never sign in. Rejected before
 * any write. Maps to public PLATFORM_INVALID_INPUT with a machine-readable reason.
 */
export class AdminUserPasswordAuthDisabledError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
  readonly reasonCode = 'password_auth_disabled' as const;

  constructor() {
    super(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    this.name = 'AdminUserPasswordAuthDisabledError';
  }
}

/**
 * Invalid retained-session candidate on revokeSessions (missing / expired / foreign).
 * Maps to public PLATFORM_INVALID_INPUT without leaking whether a foreign session exists.
 */
export class InvalidRetainedSessionError extends Error {
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
  readonly reasonCode:
    'retained_session_missing' | 'retained_session_expired' | 'retained_session_invalid';

  constructor(
    reasonCode:
      | 'retained_session_missing'
      | 'retained_session_expired'
      | 'retained_session_invalid' = 'retained_session_invalid',
  ) {
    super(PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT);
    this.name = 'InvalidRetainedSessionError';
    this.reasonCode = reasonCode;
  }
}

/** One-way fingerprint of search text — never store full query. */
export const fingerprintQuery = (query: string | undefined): string | null => {
  if (!query) return null;
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
};

const generateEntityId = (prefix: string): string => prefix + randomBytes(6).toString('hex');

/**
 * Walk the error cause chain for a Postgres unique violation (23505).
 * Returns the constraint hint (constraint name or message) — never row values.
 */
const findUniqueViolation = (error: unknown): { constraint: string } | null => {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
    };
    if (candidate.code === '23505') {
      return {
        constraint:
          typeof candidate.constraint === 'string'
            ? candidate.constraint
            : String(candidate.message ?? ''),
      };
    }
    current = candidate.cause;
  }
  return null;
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
    if (!detail) {
      await this.appendAuditBestEffort({
        action: 'admin.users.get',
        actorUserId: meta?.actorUserId,
        afterDiff: { error: 'not_found' },
        result: 'failure',
        targetId: userId,
        targetType: 'user',
      });
      throw new AdminUserNotFoundError();
    }

    await this.appendAuditBestEffort({
      action: 'admin.users.get',
      actorUserId: meta?.actorUserId,
      result: 'success',
      targetId: userId,
      targetType: 'user',
    });

    return {
      ...detail,
      isSelf: Boolean(meta?.actorUserId) && meta!.actorUserId === userId,
    };
  };

  getAuditTrail = async (
    input: AdminUsersGetAuditTrailInputParsed,
    meta?: { actorUserId?: string },
  ) => {
    const exists = await this.users.findBanState(input.userId);
    if (!exists) {
      await this.appendAuditBestEffort({
        action: 'admin.users.getAuditTrail',
        actorUserId: meta?.actorUserId,
        afterDiff: { error: 'not_found' },
        result: 'failure',
        targetId: input.userId,
        targetType: 'user',
      });
      throw new AdminUserNotFoundError();
    }

    const model = new PlatformAuditLogModel(this.db);
    const result = await model.list({
      cursor: input.cursor,
      limit: input.limit,
      targetId: input.userId,
      targetType: 'user',
    });

    await this.appendAuditBestEffort({
      action: 'admin.users.getAuditTrail',
      actorUserId: meta?.actorUserId,
      afterDiff: { itemCount: result.items.length },
      result: 'success',
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

  revokeSessions = async (params: {
    actorSessionId?: string | null;
    actorUserId: string;
    input: AdminUsersRevokeSessionsInput;
  }) => {
    const { actorUserId, actorSessionId, input } = params;

    // Not-found audit must persist even when mutation aborts (R2-03).
    const exists = await this.users.findBanState(input.userId);
    if (!exists) {
      await this.appendAuditBestEffort({
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

    // ── Targeted revoke: delete only the listed session rows (no epoch advance) ──
    if (input.sessionIds && input.sessionIds.length > 0) {
      const uniqueIds = [...new Set(input.sessionIds)];
      try {
        const revokedCount = await this.db.transaction(async (tx) => {
          const model = new AdminUserModel(tx);
          const belonging = await model.countSessionsBelongingToUser({
            sessionIds: uniqueIds,
            userId: input.userId,
          });
          if (belonging !== uniqueIds.length) {
            // Some ids are foreign/unknown — reject without leaking which.
            throw new InvalidRetainedSessionError('retained_session_invalid');
          }

          const count = await model.revokeSpecificSessions({
            sessionIds: uniqueIds,
            userId: input.userId,
          });

          await this.appendAuditInDb(tx, {
            action: 'admin.users.revokeSessions',
            actorUserId,
            afterDiff: { mode: 'targeted', requested: uniqueIds.length, revokedCount: count },
            reason: input.reason,
            result: 'success',
            targetId: input.userId,
            targetType: 'user',
          });

          return count;
        });

        // Targeted revoke keeps the user's other sessions alive — do not touch OIDC epoch.
        await this.publishUserSecurityInvalidation(input.userId);

        return { revokedCount, userId: input.userId };
      } catch (error) {
        if (error instanceof InvalidRetainedSessionError) {
          await this.appendAuditBestEffort({
            action: 'admin.users.revokeSessions',
            actorUserId,
            afterDiff: { error: error.reasonCode, mode: 'targeted', retainedSessionAttempt: true },
            reason: input.reason,
            result: 'denied',
            targetId: input.userId,
            targetType: 'user',
          });
          throw error;
        }
        throw error;
      }
    }

    /**
     * includeCurrent=false (actor===target with trusted sessionId):
     * delete other BA sessions, advance authInvalidatedAt, record retained
     * session id as cutoff exception. Never rewrites session.createdAt
     * (reauth clock unchanged). OIDC/API-key cannot use the exception.
     */
    const excludeSessionId =
      !input.includeCurrent && actorSessionId && input.userId === actorUserId
        ? actorSessionId
        : undefined;

    try {
      const revokedCount = await this.db.transaction(async (tx) => {
        const model = new AdminUserModel(tx);
        const cutoff = new Date();

        if (excludeSessionId) {
          const ok = await model.assertSessionBelongsToUser({
            sessionId: excludeSessionId,
            userId: input.userId,
          });
          if (!ok) {
            // Distinct internal error so outer path can audit without leaking ownership.
            throw new InvalidRetainedSessionError('retained_session_invalid');
          }
        }

        const count = await model.revokeSessionsForUser({
          excludeSessionId,
          userId: input.userId,
        });

        // Full revoke (includeCurrent or no retainable session) clears exception.
        await model.invalidateAuth({
          at: cutoff,
          excludedSessionId: excludeSessionId ?? null,
          userId: input.userId,
        });

        await this.appendAuditInDb(tx, {
          action: 'admin.users.revokeSessions',
          actorUserId,
          afterDiff: {
            includeCurrent: Boolean(input.includeCurrent),
            preservedSession: Boolean(excludeSessionId),
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
    } catch (error) {
      if (error instanceof InvalidRetainedSessionError) {
        // Mutation rolled back; persist sanitized denial outside the txn (R3-03).
        await this.appendAuditBestEffort({
          action: 'admin.users.revokeSessions',
          actorUserId,
          afterDiff: {
            error: error.reasonCode,
            // Never log session tokens.
            retainedSessionAttempt: true,
          },
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
          targetType: 'user',
        });
        throw error;
      }
      throw error;
    }
  };

  /**
   * Create a credential (email + password) user with base platform access.
   * Users row + Better Auth credential account +
   * `platform_user` role + success audit commit in ONE transaction. The raw
   * password is hashed (Better Auth scrypt) before the transaction; neither the
   * password nor its hash ever reaches audit rows, logs, or error messages.
   */
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
      // Role replace + both success audit rows in one outer transaction (R2-03 success atomicity).
      const result = await this.db.transaction(async (tx) => {
        const rbacService = new PlatformRbacService(tx as LobeChatDatabase);
        const replaced = await rbacService.replaceUserGlobalRoles({
          actorUserId,
          expiresAt: input.expiresAt,
          preserveRoleNames: input.preserveRoleNames,
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
