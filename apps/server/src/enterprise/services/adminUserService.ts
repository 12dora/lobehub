/**
 * Admin user management service (M04) — thin façade for router compatibility.
 * Behavior lives in focused services under ./adminUser/.
 */
import type { LobeChatDatabase } from '@/database/type';
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
import { AdminUserLifecycleService } from './adminUser/lifecycleService';
import { AdminUserReadService } from './adminUser/readService';
import { AdminUserRoleService } from './adminUser/roleService';
import { AdminUserSessionService } from './adminUser/sessionService';
import { AdminUserSupport } from './adminUser/support';
import type { AuditAction } from './audit/auditActionCatalog';
import type { PlatformConfigInvalidationPublisher } from './platformConfigInvalidation';

export {
  AdminUserEmailConflictError,
  AdminUserNotFoundError,
  AdminUserPasswordAuthDisabledError,
  AdminUserSelfBanError,
  AdminUserSelfDeleteError,
  fingerprintQuery,
  InvalidRetainedSessionError,
} from './adminUser/errors';

export class AdminUserService {
  private readonly read: AdminUserReadService;
  private readonly lifecycle: AdminUserLifecycleService;
  private readonly sessions: AdminUserSessionService;
  private readonly roles: AdminUserRoleService;
  private readonly support: AdminUserSupport;

  constructor(
    db: LobeChatDatabase,
    options?: {
      invalidation?: PlatformConfigInvalidationPublisher;
    },
  ) {
    this.read = new AdminUserReadService(db, options);
    this.lifecycle = new AdminUserLifecycleService(db, options);
    this.sessions = new AdminUserSessionService(db, options);
    this.roles = new AdminUserRoleService(db, options);
    this.support = new AdminUserSupport(db, options);
  }

  list = (input: AdminUsersListInputParsed, meta?: { actorUserId?: string }) =>
    this.read.list(input, meta);

  get = (userId: string, meta?: { actorUserId?: string }) => this.read.get(userId, meta);

  getAuditTrail = (input: AdminUsersGetAuditTrailInputParsed, meta?: { actorUserId?: string }) =>
    this.read.getAuditTrail(input, meta);

  ban = (params: { actorUserId: string; input: AdminUsersBanInput }) => this.lifecycle.ban(params);

  unban = (params: { actorUserId: string; input: AdminUsersUnbanInput }) =>
    this.lifecycle.unban(params);

  createUser = (params: { actorUserId: string; input: AdminUsersCreateInput }) =>
    this.lifecycle.createUser(params);

  deleteUser = (params: { actorUserId: string; input: AdminUsersDeleteInput }) =>
    this.lifecycle.deleteUser(params);

  revokeSessions = (params: {
    actorSessionId?: string | null;
    actorUserId: string;
    input: AdminUsersRevokeSessionsInput;
  }) => this.sessions.revokeSessions(params);

  replaceGlobalRoles = (params: {
    actorUserId: string;
    input: AdminUsersReplaceGlobalRolesInput;
  }) => this.roles.replaceGlobalRoles(params);

  /** Record denied reauth for high-risk mutations (router-level). */
  recordReauthDenied = async (params: {
    action: AuditAction;
    actorUserId: string;
    reason?: string;
    targetId?: string;
  }) => {
    await this.support.appendAuditBestEffort({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: { error: 'reauth_required' },
      reason: params.reason ?? null,
      result: 'denied',
      targetId: params.targetId,
      targetType: 'user',
    });
  };
}

export type AdminUserMutationAuth = {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod | null;
  sessionId?: string | null;
  userId: string;
};
