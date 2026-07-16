import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminUsersBanInput,
  AdminUsersBanOutput,
  AdminUsersGetAuditTrailInput,
  AdminUsersGetAuditTrailOutput,
  AdminUsersGetInput,
  AdminUsersGetOutput,
  AdminUsersListInput,
  AdminUsersListOutput,
  AdminUsersReplaceGlobalRolesInput,
  AdminUsersReplaceGlobalRolesOutput,
  AdminUsersRevokeSessionsInput,
  AdminUsersRevokeSessionsOutput,
  AdminUsersUnbanInput,
  AdminUsersUnbanOutput,
} from '@/server/enterprise/contracts/adminUsers';

/**
 * Typed client wrappers for `admin.users.*`.
 * Do not re-declare Zod contracts client-side — types come from the server contract.
 */
class AdminUsersService {
  list = async (input: AdminUsersListInput = {}): Promise<AdminUsersListOutput> => {
    return lambdaClient.admin.users.list.query(input);
  };

  get = async (input: AdminUsersGetInput): Promise<AdminUsersGetOutput> => {
    return lambdaClient.admin.users.get.query(input);
  };

  getAuditTrail = async (
    input: AdminUsersGetAuditTrailInput,
  ): Promise<AdminUsersGetAuditTrailOutput> => {
    return lambdaClient.admin.users.getAuditTrail.query(input);
  };

  ban = async (input: AdminUsersBanInput): Promise<AdminUsersBanOutput> => {
    return lambdaClient.admin.users.ban.mutate(input);
  };

  unban = async (input: AdminUsersUnbanInput): Promise<AdminUsersUnbanOutput> => {
    return lambdaClient.admin.users.unban.mutate(input);
  };

  revokeSessions = async (
    input: AdminUsersRevokeSessionsInput,
  ): Promise<AdminUsersRevokeSessionsOutput> => {
    return lambdaClient.admin.users.revokeSessions.mutate(input);
  };

  replaceGlobalRoles = async (
    input: AdminUsersReplaceGlobalRolesInput,
  ): Promise<AdminUsersReplaceGlobalRolesOutput> => {
    return lambdaClient.admin.users.replaceGlobalRoles.mutate(input);
  };
}

export const adminUsersService = new AdminUsersService();

export type {
  AdminUsersBanInput,
  AdminUsersBanOutput,
  AdminUsersGetAuditTrailInput,
  AdminUsersGetAuditTrailOutput,
  AdminUsersGetInput,
  AdminUsersGetOutput,
  AdminUsersListInput,
  AdminUsersListOutput,
  AdminUsersReplaceGlobalRolesInput,
  AdminUsersReplaceGlobalRolesOutput,
  AdminUsersRevokeSessionsInput,
  AdminUsersRevokeSessionsOutput,
  AdminUsersUnbanInput,
  AdminUsersUnbanOutput,
};
