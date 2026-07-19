import { WORKSPACE_SYSTEM_ROLES } from '@lobechat/const/rbac';
import { eq, inArray } from 'drizzle-orm';

import { PLATFORM_SYSTEM_ROLES, type PlatformSystemRoleName } from '@/const/platform/roles';
import { RbacModel } from '@/database/models/rbac';
import { platformAuditLogs, userRoles, users, workspaces } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { seedWorkspaceRoles } from '@/database/utils/seedWorkspaceRoles';
import { createContextInner } from '@/libs/trpc/lambda/context';

export const ADMIN_AUTHORIZATION_FIXTURE_IDS = {
  aiAdmin: 'admin-authorization-ai-admin',
  auditor: 'admin-authorization-auditor',
  identityAdmin: 'admin-authorization-identity-admin',
  normal: 'admin-authorization-normal',
  superAdmin: 'admin-authorization-super-admin',
  userAdmin: 'admin-authorization-user-admin',
  workspace: 'admin-authorization-workspace',
  workspaceOwner: 'admin-authorization-workspace-owner',
} as const;

export type AdminAuthorizationPrincipal = Exclude<
  keyof typeof ADMIN_AUTHORIZATION_FIXTURE_IDS,
  'workspace'
>;

const userIds = [
  ADMIN_AUTHORIZATION_FIXTURE_IDS.aiAdmin,
  ADMIN_AUTHORIZATION_FIXTURE_IDS.auditor,
  ADMIN_AUTHORIZATION_FIXTURE_IDS.identityAdmin,
  ADMIN_AUTHORIZATION_FIXTURE_IDS.normal,
  ADMIN_AUTHORIZATION_FIXTURE_IDS.superAdmin,
  ADMIN_AUTHORIZATION_FIXTURE_IDS.userAdmin,
  ADMIN_AUTHORIZATION_FIXTURE_IDS.workspaceOwner,
] as const;

const globalRoles: ReadonlyArray<readonly [AdminAuthorizationPrincipal, PlatformSystemRoleName]> = [
  ['superAdmin', PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
  ['userAdmin', PLATFORM_SYSTEM_ROLES.USER_ADMIN],
  ['aiAdmin', PLATFORM_SYSTEM_ROLES.AI_ADMIN],
  ['identityAdmin', PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN],
  ['auditor', PLATFORM_SYSTEM_ROLES.AUDITOR],
  ['normal', PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
  ['workspaceOwner', PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
];

export const cleanupAdminAuthorizationFixture = async (db: LobeChatDatabase): Promise<void> => {
  await db.delete(platformAuditLogs).where(inArray(platformAuditLogs.actorUserId, userIds));
  await db.delete(userRoles).where(inArray(userRoles.userId, userIds));
  await db.delete(workspaces).where(eq(workspaces.id, ADMIN_AUTHORIZATION_FIXTURE_IDS.workspace));
  await db.delete(users).where(inArray(users.id, userIds));
};

export const setupAdminAuthorizationFixture = async (db: LobeChatDatabase): Promise<void> => {
  await cleanupAdminAuthorizationFixture(db);
  await db.insert(users).values(userIds.map((id) => ({ id })));
  await db.insert(workspaces).values({
    id: ADMIN_AUTHORIZATION_FIXTURE_IDS.workspace,
    name: 'Admin Authorization Matrix',
    primaryOwnerId: ADMIN_AUTHORIZATION_FIXTURE_IDS.workspaceOwner,
    slug: ADMIN_AUTHORIZATION_FIXTURE_IDS.workspace,
  });

  await seedPlatformRoles(db);
  await seedWorkspaceRoles(db, ADMIN_AUTHORIZATION_FIXTURE_IDS.workspace);
  for (const [principal, roleName] of globalRoles) {
    await assignGlobalPlatformRole(db, {
      roleName,
      userId: ADMIN_AUTHORIZATION_FIXTURE_IDS[principal],
    });
  }

  await new RbacModel(db, ADMIN_AUTHORIZATION_FIXTURE_IDS.workspaceOwner).assignWorkspaceRole({
    roleName: WORKSPACE_SYSTEM_ROLES.OWNER,
    userId: ADMIN_AUTHORIZATION_FIXTURE_IDS.workspaceOwner,
    workspaceId: ADMIN_AUTHORIZATION_FIXTURE_IDS.workspace,
  });
};

const createFixtureContext = async (
  db: LobeChatDatabase,
  principal: AdminAuthorizationPrincipal,
  options: {
    apiKey?: boolean;
    staleReauth?: boolean;
  } = {},
) => {
  const now = new Date();
  const context = await createContextInner({
    authenticatedAt: options.apiKey
      ? null
      : options.staleReauth
        ? new Date(now.getTime() - 2 * 60 * 60 * 1000)
        : now,
    authMethod: options.apiKey ? 'api-key' : 'better-auth',
    credentialIssuedAt: now,
    userId: ADMIN_AUTHORIZATION_FIXTURE_IDS[principal],
    workspaceId: principal === 'workspaceOwner' ? ADMIN_AUTHORIZATION_FIXTURE_IDS.workspace : null,
  });
  return { ...context, serverDB: db };
};

export const createAdminAuthorizationContexts = async (db: LobeChatDatabase) => ({
  aiAdmin: await createFixtureContext(db, 'aiAdmin'),
  anonymous: { ...(await createContextInner()), serverDB: db },
  apiKeySuper: await createFixtureContext(db, 'superAdmin', { apiKey: true }),
  auditor: await createFixtureContext(db, 'auditor'),
  identityAdmin: await createFixtureContext(db, 'identityAdmin'),
  normal: await createFixtureContext(db, 'normal'),
  staleReauthSuper: await createFixtureContext(db, 'superAdmin', { staleReauth: true }),
  superAdmin: await createFixtureContext(db, 'superAdmin'),
  userAdmin: await createFixtureContext(db, 'userAdmin'),
  workspaceOwner: await createFixtureContext(db, 'workspaceOwner'),
});
