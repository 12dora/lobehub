import { randomUUID } from 'node:crypto';

import { WORKSPACE_SYSTEM_ROLES } from '@lobechat/const/rbac';
import { eq, inArray, or } from 'drizzle-orm';

import { PLATFORM_SYSTEM_ROLES, type PlatformSystemRoleName } from '@/const/platform/roles';
import { RbacModel } from '@/database/models/rbac';
import { userRoles, users, workspaces } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { seedWorkspaceRoles } from '@/database/utils/seedWorkspaceRoles';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { ADMIN_REAUTH_MAX_AGE_MS } from '../contracts/adminUsers';

import { deletePlatformAuditLogsForTest } from './deletePlatformAuditLogs';

export interface AdminAuthorizationFixtureOptions {
  namespace?: string;
}

export interface AdminAuthorizationActors {
  aiAdmin: string;
  auditor: string;
  identityAdmin: string;
  normal: string;
  superAdmin: string;
  userAdmin: string;
  workspaceOwner: string;
}

export type AdminAuthorizationPrincipal = keyof AdminAuthorizationActors;

const roleSeedByDatabase = new WeakMap<object, Promise<void>>();

/** Serialize the production seed helper per test database so concurrent fixtures cannot race its
 * read-before-insert global role path. This coordination is test-only and does not alter RBAC. */
const seedGlobalRolesForFixture = async (db: LobeChatDatabase): Promise<void> => {
  const key = db as object;
  const previous = roleSeedByDatabase.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await seedPlatformRoles(db);
    });
  roleSeedByDatabase.set(key, current);
  try {
    await current;
  } finally {
    if (roleSeedByDatabase.get(key) === current) roleSeedByDatabase.delete(key);
  }
};

const createNamespace = (label?: string): string => {
  const readable = (label ?? 'fixture')
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 18);
  const unique = randomUUID().replaceAll('-', '');
  return `admin-auth-${readable || 'fixture'}-${unique}`;
};

export const createAdminAuthorizationFixture = (options: AdminAuthorizationFixtureOptions = {}) => {
  const namespace = createNamespace(options.namespace);
  const actors: AdminAuthorizationActors = Object.freeze({
    aiAdmin: `${namespace}-ai-admin`,
    auditor: `${namespace}-auditor`,
    identityAdmin: `${namespace}-identity-admin`,
    normal: `${namespace}-normal`,
    superAdmin: `${namespace}-super-admin`,
    userAdmin: `${namespace}-user-admin`,
    workspaceOwner: `${namespace}-workspace-owner`,
  });
  const workspaceId = `${namespace}-workspace`;
  const actorIds = Object.values(actors);
  const globalRoles: ReadonlyArray<readonly [AdminAuthorizationPrincipal, PlatformSystemRoleName]> =
    [
      ['superAdmin', PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
      ['userAdmin', PLATFORM_SYSTEM_ROLES.USER_ADMIN],
      ['aiAdmin', PLATFORM_SYSTEM_ROLES.AI_ADMIN],
      ['identityAdmin', PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN],
      ['auditor', PLATFORM_SYSTEM_ROLES.AUDITOR],
      ['normal', PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
      ['workspaceOwner', PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
    ];

  const cleanup = async (db: LobeChatDatabase): Promise<void> => {
    // Append-only audit logs need the test GUC opt-in; scope to this fixture's actors (SG-07).
    await deletePlatformAuditLogsForTest(db, { actorUserIds: actorIds });
    await db.transaction(async (tx) => {
      await tx
        .delete(userRoles)
        .where(or(inArray(userRoles.userId, actorIds), eq(userRoles.workspaceId, workspaceId)));
      await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await tx.delete(users).where(inArray(users.id, actorIds));
    });
  };

  const setup = async (db: LobeChatDatabase): Promise<void> => {
    await cleanup(db);
    await db.insert(users).values(actorIds.map((id) => ({ id })));
    await db.insert(workspaces).values({
      id: workspaceId,
      name: `Admin Authorization ${namespace}`,
      primaryOwnerId: actors.workspaceOwner,
      slug: workspaceId,
    });

    await seedGlobalRolesForFixture(db);
    await seedWorkspaceRoles(db, workspaceId);
    for (const [principal, roleName] of globalRoles) {
      await assignGlobalPlatformRole(db, {
        roleName,
        userId: actors[principal],
      });
    }

    await new RbacModel(db, actors.workspaceOwner).assignWorkspaceRole({
      roleName: WORKSPACE_SYSTEM_ROLES.OWNER,
      userId: actors.workspaceOwner,
      workspaceId,
    });
  };

  const createFixtureContext = async (
    db: LobeChatDatabase,
    principal: AdminAuthorizationPrincipal,
    contextOptions: {
      apiKey?: boolean;
      staleReauth?: boolean;
    } = {},
  ) => {
    const now = new Date();
    const context = await createContextInner({
      authenticatedAt: contextOptions.apiKey
        ? null
        : contextOptions.staleReauth
          ? // Derived from the window itself. A literal two hours stopped being stale the day the
            // reauth window moved to eight, and every `staleReauthSuper` case went on asserting a
            // denial that the guard was no longer being asked for.
            new Date(now.getTime() - ADMIN_REAUTH_MAX_AGE_MS - 1000)
          : now,
      authMethod: contextOptions.apiKey ? 'api-key' : 'better-auth',
      credentialIssuedAt: now,
      userId: actors[principal],
      workspaceId: principal === 'workspaceOwner' ? workspaceId : null,
    });
    return { ...context, serverDB: db };
  };

  const createContexts = async (db: LobeChatDatabase) => ({
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

  return Object.freeze({ actors, cleanup, createContexts, namespace, setup, workspaceId });
};
