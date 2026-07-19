// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { getServerDB } from '@/database/core/db-adaptor';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(adminRouter);
const ids = { operator: 'm11-system-operator', reader: 'm11-system-reader' };
const roleName = 'm11_oidc_restart_operator';

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));

const cleanup = async () => {
  await db.delete(platformIdentityProviderRestartRequests);
  await db.delete(platformIdentityProviderInstances);
  await db.delete(platformAuditLogs);
  const ownedRoles = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, roleName));
  if (ownedRoles.length > 0) {
    const roleIds = ownedRoles.map(({ id }) => id);
    await db.delete(userRoles).where(inArray(userRoles.roleId, roleIds));
    await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await db.delete(roles).where(inArray(roles.id, roleIds));
  }
  await db.delete(users).where(sql`${users.id} LIKE 'm11-system-%'`);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  const [role] = await db
    .insert(roles)
    .values({ displayName: roleName, name: roleName })
    .returning();
  const [permission] = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.code, PLATFORM_PERMISSIONS.OIDC_PUBLISH));
  await db.insert(rolePermissions).values({ permissionId: permission.id, roleId: role.id });
  await db.insert(userRoles).values({ roleId: role.id, userId: ids.operator, workspaceId: null });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (userId: string, authenticatedAt = new Date()) => {
  const context = await createContextInner({
    authenticatedAt,
    authMethod: 'better-auth',
    sessionId: `session-${userId}`,
    userId,
  });
  return createCaller({ ...context, serverDB: db } as never).system;
};

describe('admin.system OIDC restart gate', () => {
  it('requires the dedicated platform_oidc:publish:all permission', async () => {
    const reader = await callerFor(ids.reader);
    await expect(reader.getAuthSnapshotStatus()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects at the feature flag before DB and RBAC access', async () => {
    const operator = await callerFor(ids.operator);
    vi.stubEnv('ENABLE_DATABASE_OIDC', '0');
    vi.mocked(getServerDB).mockClear();
    const select = vi.spyOn(db, 'select');
    await expect(operator.getAuthSnapshotStatus()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
    expect(getServerDB).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });

  it('audits stale reauthentication denial before preparing any restart intent', async () => {
    const operator = await callerFor(ids.operator, new Date(Date.now() - 60 * 60 * 1000));
    await expect(
      operator.prepareRestart({
        reason: 'Activate the tested provider',
        requestId: '550e8400-e29b-41d4-a716-446655440056',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'ADMIN_REAUTH_REQUIRED' });
    expect(await db.select().from(platformIdentityProviderRestartRequests)).toHaveLength(0);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.system.requestRestart',
        result: 'denied',
      }),
    );
  });
});
