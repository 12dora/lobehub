/**
 * Centralized Zod contracts for `admin.users` (M04).
 * Procedures must import these schemas — do not redefine inputs/outputs inline.
 *
 * Dates are real `Date` values (superjson over tRPC). Secrets, tokens, and account
 * scope payloads are never part of these shapes. The create INPUT carries an initial
 * password (hashed server-side, never stored raw); passwords never appear in any
 * output, list, or audit shape.
 *
 * Implementation is split by subdomain under `./adminUsers/`; this file is the stable
 * public barrel so existing `.../contracts/adminUsers` import paths remain valid.
 */

export {
  type AdminUserAuditItem,
  adminUserAuditItemSchema,
  type AdminUsersGetAuditTrailInput,
  type AdminUsersGetAuditTrailInputParsed,
  adminUsersGetAuditTrailInputSchema,
  type AdminUsersGetAuditTrailOutput,
  adminUsersGetAuditTrailOutputSchema,
} from './adminUsers/audit';
export {
  ADMIN_REAUTH_MAX_AGE_MS,
  ADMIN_USER_ASSIGNABLE_ROLE_NAMES,
  ADMIN_USERS_AUDIT_DEFAULT_LIMIT,
  ADMIN_USERS_LIST_DEFAULT_LIMIT,
  ADMIN_USERS_LIST_MAX_LIMIT,
  ADMIN_USERS_LIST_MAX_OFFSET,
  type AdminUserAssignableRoleName,
  adminUserAssignableRoleNameSchema,
  adminUserCursorSchema,
  type AdminUserSource,
  adminUserSourceSchema,
  type AdminUserStatus,
  adminUserStatusSchema,
  escapeLikePattern,
  normalizeAdminUserQuery,
} from './adminUsers/common';
export {
  adminUserGlobalRoleSchema,
  type AdminUserProviderSummary,
  adminUserProviderSummarySchema,
  type AdminUserSessionSummary,
  adminUserSessionSummarySchema,
  type AdminUsersGetInput,
  adminUsersGetInputSchema,
  type AdminUsersGetOutput,
  adminUsersGetOutputSchema,
} from './adminUsers/detail';
export {
  type AdminUserListItem,
  adminUserListItemSchema,
  type AdminUsersListInput,
  type AdminUsersListInputParsed,
  adminUsersListInputSchema,
  type AdminUsersListOutput,
  adminUsersListOutputSchema,
} from './adminUsers/list';
export {
  type AdminUsersBanInput,
  adminUsersBanInputSchema,
  type AdminUsersBanOutput,
  adminUsersBanOutputSchema,
  type AdminUsersCreateInput,
  adminUsersCreateInputSchema,
  type AdminUsersCreateOutput,
  adminUsersCreateOutputSchema,
  type AdminUsersDeleteInput,
  adminUsersDeleteInputSchema,
  type AdminUsersDeleteOutput,
  adminUsersDeleteOutputSchema,
  type AdminUsersDisableTwoFactorInput,
  adminUsersDisableTwoFactorInputSchema,
  type AdminUsersDisableTwoFactorOutput,
  adminUsersDisableTwoFactorOutputSchema,
  type AdminUsersReplaceGlobalRolesInput,
  adminUsersReplaceGlobalRolesInputSchema,
  type AdminUsersReplaceGlobalRolesOutput,
  adminUsersReplaceGlobalRolesOutputSchema,
  type AdminUsersRevokeSessionsInput,
  adminUsersRevokeSessionsInputSchema,
  type AdminUsersRevokeSessionsOutput,
  adminUsersRevokeSessionsOutputSchema,
  type AdminUsersSetPasswordInput,
  adminUsersSetPasswordInputSchema,
  type AdminUsersSetPasswordOutput,
  adminUsersSetPasswordOutputSchema,
  type AdminUsersUnbanInput,
  adminUsersUnbanInputSchema,
  type AdminUsersUnbanOutput,
  adminUsersUnbanOutputSchema,
} from './adminUsers/mutations';
