// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import {
  permissions,
  platformAuditLogs,
  platformConnectorGovernance,
  platformManagedResourcePolicies,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(adminRouter);
const ids = {
  aiAdmin: 'gov-admin-ai-admin',
  auditor: 'gov-admin-auditor',
  normal: 'gov-admin-normal',
  owner: 'gov-admin-owner',
  reader: 'gov-admin-reader',
  updater: 'gov-admin-updater',
};

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await db.delete(platformConnectorGovernance);
  await db.delete(platformManagedResourcePolicies);
  await db.delete(platformAuditLogs);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users).where(sql`${users.id} LIKE 'gov-admin-%'`);
};

const grantPermissions = async (userId: string, name: string, codes: string[]) => {
  const [role] = await db
    .insert(roles)
    .values({ displayName: name, name, workspaceId: null })
    .returning();
  const rows = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, codes));
  await db
    .insert(rolePermissions)
    .values(rows.map(({ id }) => ({ permissionId: id, roleId: role.id })));
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
    userId: ids.aiAdmin,
  });
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AUDITOR,
    userId: ids.auditor,
  });
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    userId: ids.normal,
  });
  await grantPermissions(ids.reader, 'gov_connector_reader', [PLATFORM_PERMISSIONS.CONNECTOR_READ]);
  await grantPermissions(ids.updater, 'gov_connector_updater', [
    PLATFORM_PERMISSIONS.CONNECTOR_UPDATE,
  ]);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const STALE = new Date(Date.now() - 24 * 60 * 60 * 1000);

const callerFor = async (params: {
  authenticatedAt?: Date | null;
  authMethod?: 'api-key' | 'better-auth';
  userId?: string;
}) => {
  const caller = createRootCaller({
    ...(await createContextInner({
      authenticatedAt: params.authenticatedAt,
      authMethod: params.authMethod ?? 'better-auth',
      userId: params.userId,
    })),
    serverDB: db,
  } as never);
  return caller.connectors;
};

const auditRows = async (action: string) =>
  db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, action));

describe('admin.connectors governance RBAC and contract', () => {
  it('denies anonymous and unauthorized users on all three procedures', async () => {
    const anonymous = await callerFor({});
    await expect(anonymous.getGovernance()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const normal = await callerFor({ authenticatedAt: new Date(), userId: ids.normal });
    await expect(normal.getGovernance()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      normal.updateBuiltinToolPolicy({ expectedRevision: 0, policies: {}, reason: 'denied' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      normal.setSharedAuthorization({
        expectedRevision: 0,
        ownerUserId: ids.owner,
        reason: 'denied',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Read permission alone cannot mutate; auditor stays read-only.
    for (const userId of [ids.reader, ids.auditor]) {
      const readOnly = await callerFor({ authenticatedAt: new Date(), userId });
      await expect(readOnly.getGovernance()).resolves.toEqual({
        doc: { builtinToolPolicies: {}, sharedAuthorization: { ownerUserId: null } },
        managedActive: false,
        revision: 0,
      });
      await expect(
        readOnly.updateBuiltinToolPolicy({ expectedRevision: 0, policies: {}, reason: 'denied' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('publishes the builtin tool matrix without reauth, audits, and maps revision conflicts', async () => {
    // Stale interactive session on purpose: this mutation must not require reauth.
    const updater = await callerFor({ authenticatedAt: STALE, userId: ids.updater });
    const policies = { 'lobe-task': { createTask: 'needs_approval' as const } };
    await expect(
      updater.updateBuiltinToolPolicy({
        expectedRevision: 0,
        policies,
        reason: 'restrict task creation',
      }),
    ).resolves.toEqual({ revision: 1 });

    const reader = await callerFor({ authenticatedAt: new Date(), userId: ids.reader });
    await expect(reader.getGovernance()).resolves.toEqual({
      doc: { builtinToolPolicies: policies, sharedAuthorization: { ownerUserId: null } },
      managedActive: false,
      revision: 1,
    });

    const success = await auditRows('admin.connectors.updateBuiltinToolPolicy');
    expect(success).toContainEqual(
      expect.objectContaining({
        actorUserId: ids.updater,
        result: 'success',
        targetId: 'governance:connectors',
        targetType: 'connector_governance',
      }),
    );

    await expect(
      updater.updateBuiltinToolPolicy({
        expectedRevision: 0,
        policies: {},
        reason: 'stale revision write',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
    });
    expect(await auditRows('admin.connectors.updateBuiltinToolPolicy')).toContainEqual(
      expect.objectContaining({ result: 'failure' }),
    );
  });

  it('requires recent reauth for setSharedAuthorization and audits the denial', async () => {
    const stale = await callerFor({ authenticatedAt: STALE, userId: ids.updater });
    await expect(
      stale.setSharedAuthorization({
        expectedRevision: 0,
        ownerUserId: ids.owner,
        reason: 'must require reauth',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await auditRows('admin.connectors.setSharedAuthorization')).toContainEqual(
      expect.objectContaining({ actorUserId: ids.updater, result: 'denied' }),
    );

    const fresh = await callerFor({ authenticatedAt: new Date(), userId: ids.updater });
    await expect(
      fresh.setSharedAuthorization({
        expectedRevision: 0,
        ownerUserId: ids.owner,
        reason: 'designate shared identity',
      }),
    ).resolves.toEqual({ revision: 1 });
    expect(await auditRows('admin.connectors.setSharedAuthorization')).toContainEqual(
      expect.objectContaining({ actorUserId: ids.updater, result: 'success' }),
    );

    // null clears back to per-user authorization.
    await expect(
      fresh.setSharedAuthorization({
        expectedRevision: 1,
        ownerUserId: null,
        reason: 'clear shared identity',
      }),
    ).resolves.toEqual({ revision: 2 });

    await expect(
      fresh.setSharedAuthorization({
        expectedRevision: 2,
        ownerUserId: 'gov-admin-missing-user',
        reason: 'owner must exist',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
    });
  });

  it('reports managedActive when the connectors policy is effectively enforced', async () => {
    const policyModel = new PlatformManagedResourcePolicyModel(db);
    await policyModel.ensureRows();
    const policies = createUnmanagedResourcePolicyMap();
    policies.connectors = { enforcementMode: 'enforced', managed: true };
    await policyModel.materializePublished({ policies, revision: 1 });

    const aiAdmin = await callerFor({ authenticatedAt: new Date(), userId: ids.aiAdmin });
    await expect(aiAdmin.getGovernance()).resolves.toMatchObject({ managedActive: true });

    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '0');
    await expect(aiAdmin.getGovernance()).resolves.toMatchObject({ managedActive: false });
  });
});
