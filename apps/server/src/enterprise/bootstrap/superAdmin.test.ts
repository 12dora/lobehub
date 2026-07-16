// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { RbacModel } from '@/database/models/rbac';
import { permissions, rolePermissions, roles, userRoles, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { bootstrapSuperAdmin, ensurePlatformRbacSeeded } from './superAdmin';

const db: LobeChatDatabase = await getTestDB();
const userId = 'bootstrap-user';

const cleanup = async () => {
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values({ id: userId, email: 'admin@example.com' });
});

afterEach(async () => {
  await cleanup();
});

describe('bootstrapSuperAdmin', () => {
  it('is idempotent and grants super_admin', async () => {
    const first = await bootstrapSuperAdmin(db, { userId });
    expect(first.roleAssigned).toBe(true);
    expect(first.alreadySuperAdmin).toBe(false);

    const second = await bootstrapSuperAdmin(db, { userId });
    expect(second.roleAssigned).toBe(false);
    expect(second.alreadySuperAdmin).toBe(true);

    const rbac = new RbacModel(db, userId);
    expect(await rbac.isGlobalSuperAdmin(userId)).toBe(true);
    expect(await rbac.countActiveSuperAdmins()).toBe(1);
  });

  it('can resolve user by email', async () => {
    const result = await bootstrapSuperAdmin(db, { email: 'admin@example.com' });
    expect(result.userId).toBe(userId);
  });

  it('creates break-glass user when allowed', async () => {
    await db.delete(users);
    const result = await bootstrapSuperAdmin(db, {
      allowCreate: true,
      email: 'break@localhost',
      username: 'breakglass',
    });
    expect(result.createdUser).toBe(true);
    const rbac = new RbacModel(db, result.userId);
    expect(await rbac.isGlobalSuperAdmin(result.userId)).toBe(true);
  });

  it('ensurePlatformRbacSeeded seeds roles without promoting users', async () => {
    const { superAdminCount } = await ensurePlatformRbacSeeded(db);
    expect(superAdminCount).toBe(0);
    const role = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    expect(role).toBeTruthy();
  });
});
