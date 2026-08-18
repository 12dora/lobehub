import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type { AdminProcedureAuthorization } from './types';

/** Authorization declarations for admin.auth/authSettings/identityProviders/users/roles/creds procedures. */
export const ADMIN_PROCEDURE_AUTHORIZATION_IDENTITY_ACCESS = [
  { kind: 'query', path: 'admin.auth.getMyAccess', selfAccess: true },
  {
    kind: 'query',
    path: 'admin.authSettings.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.authSettings.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.create',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.delete',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.disable',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.discover',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_TEST] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.getCallbackUrls',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.listPublishedRevisions',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.rollback',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_PUBLISH] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.testResult',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_TEST] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.testStart',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_TEST] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.validateNetwork',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_TEST] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.ban',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_BAN] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.create',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.delete',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.disableTwoFactor',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_CREDENTIAL_MANAGE] },
  },
  {
    kind: 'query',
    path: 'admin.users.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_READ] },
  },
  {
    kind: 'query',
    path: 'admin.users.getAuditTrail',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.users.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.replaceGlobalRoles',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_ROLE_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.revokeSessions',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_SESSION_REVOKE] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.setPassword',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_CREDENTIAL_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.unban',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_BAN] },
  },
  {
    kind: 'query',
    path: 'admin.roles.listSystemRoles',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.ROLE_READ] },
  },
  {
    kind: 'query',
    path: 'admin.roles.listUserAssignments',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.ROLE_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.roles.replaceUserGlobalRoles',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.ROLE_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.createFile',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.createKV',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.createOAuth',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.delete',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.deleteByKey',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_DELETE] },
  },
  {
    kind: 'query',
    path: 'admin.creds.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'query',
    path: 'admin.creds.getByKey',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'query',
    path: 'admin.creds.getSkillCredStatus',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'query',
    path: 'admin.creds.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'query',
    path: 'admin.creds.listOAuthConnections',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.uploadFile',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_CREATE] },
  },
] as const satisfies readonly AdminProcedureAuthorization[];
