// @vitest-environment node
import { PERMISSION_ACTIONS, WORKSPACE_SYSTEM_ROLES } from '@lobechat/const/rbac';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { getTestDB } from '../../core/getTestDB';
import { permissions, rolePermissions, roles, userRoles, users, workspaces } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { seedPlatformRoles } from '../../utils/seedPlatformRoles';
import { seedWorkspaceRoles } from '../../utils/seedWorkspaceRoles';
import { RbacModel } from '../rbac';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'rbac-global-user';
const otherUserId = 'rbac-global-other';
const workspaceId = 'rbac-global-ws';

const cleanup = async () => {
  await serverDB.delete(userRoles);
  await serverDB.delete(rolePermissions);
  await serverDB.delete(roles);
  await serverDB.delete(permissions);
  await serverDB.delete(workspaces);
  await serverDB.delete(users);
};

beforeEach(async () => {
  await cleanup();
  await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
  await serverDB
    .insert(workspaces)
    .values([{ id: workspaceId, name: 'WS', primaryOwnerId: userId, slug: 'rbac-global-ws' }]);
  await seedWorkspaceRoles(serverDB, workspaceId);
  await seedPlatformRoles(serverDB);
});

afterEach(async () => {
  await cleanup();
});

describe('RbacModel — global platform scope (M02)', () => {
  it('workspace owner does not satisfy hasGlobalPermission', async () => {
    const rbac = new RbacModel(serverDB, userId);
    await rbac.assignWorkspaceRole({
      roleName: WORKSPACE_SYSTEM_ROLES.OWNER,
      userId,
      workspaceId,
    });

    expect(await rbac.hasGlobalPermission(PLATFORM_PERMISSIONS.ADMIN_ACCESS)).toBe(false);
    expect(await rbac.getGlobalUserPermissions()).toEqual([]);
  });

  it('super_admin global grant satisfies platform permissions', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const role = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    expect(role).toBeTruthy();
    await serverDB.insert(userRoles).values({
      roleId: role!.id,
      userId,
      workspaceId: null,
    });

    expect(await rbac.hasGlobalPermission(PLATFORM_PERMISSIONS.ADMIN_ACCESS)).toBe(true);
    expect(await rbac.hasGlobalPermission(PLATFORM_PERMISSIONS.USER_BAN)).toBe(true);
    expect(await rbac.isGlobalSuperAdmin()).toBe(true);
  });

  it('replaceGlobalUserRoles never touches workspace grants', async () => {
    const rbac = new RbacModel(serverDB, userId);
    await rbac.assignWorkspaceRole({
      roleName: WORKSPACE_SYSTEM_ROLES.OWNER,
      userId,
      workspaceId,
    });

    const userAdmin = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.USER_ADMIN), isNull(t.workspaceId)),
    });
    await rbac.replaceGlobalUserRoles(userId, [userAdmin!.id]);

    // global
    expect(await rbac.hasGlobalPermission(PLATFORM_PERMISSIONS.USER_READ)).toBe(true);
    // workspace still present
    expect(
      await rbac.hasPermission(`${PERMISSION_ACTIONS.WORKSPACE_READ}:all`, { workspaceId }),
    ).toBe(true);

    const wsGrants = await serverDB.query.userRoles.findMany({
      where: (t, { and, eq }) => and(eq(t.userId, userId), eq(t.workspaceId, workspaceId)),
    });
    expect(wsGrants.length).toBeGreaterThan(0);
  });

  it('replaceGlobalUserRoles preserves super_admin when requested', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const superAdmin = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    const auditor = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.AUDITOR), isNull(t.workspaceId)),
    });

    await serverDB.insert(userRoles).values({
      roleId: superAdmin!.id,
      userId,
      workspaceId: null,
    });

    await rbac.replaceGlobalUserRoles(userId, [auditor!.id], {
      preserveRoleNames: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
    });

    const names = (await rbac.getGlobalUserRoles()).map((r) => r.name).sort();
    expect(names).toEqual(
      [PLATFORM_SYSTEM_ROLES.AUDITOR, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN].sort(),
    );
  });

  it('rejects replaceGlobalUserRoles with workspace-scoped role ids', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const wsRole = await serverDB.query.roles.findFirst({
      where: (t, { and, eq }) =>
        and(eq(t.name, WORKSPACE_SYSTEM_ROLES.OWNER), eq(t.workspaceId, workspaceId)),
    });

    await expect(rbac.replaceGlobalUserRoles(userId, [wsRole!.id])).rejects.toThrow(
      /only accepts global roles/,
    );
  });

  it('expired global grants do not count', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const role = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.AI_ADMIN), isNull(t.workspaceId)),
    });
    await serverDB.insert(userRoles).values({
      expiresAt: new Date(Date.now() - 60_000),
      roleId: role!.id,
      userId,
      workspaceId: null,
    });

    expect(await rbac.hasGlobalPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_READ)).toBe(false);
  });

  it('countActiveSuperAdmins tracks distinct users', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const role = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    expect(await rbac.countActiveSuperAdmins()).toBe(0);

    await serverDB.insert(userRoles).values([
      { roleId: role!.id, userId, workspaceId: null },
      { roleId: role!.id, userId: otherUserId, workspaceId: null },
    ]);
    expect(await rbac.countActiveSuperAdmins()).toBe(2);
  });

  it('countActiveSuperAdmins excludes banned users (M2)', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const role = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    await serverDB.insert(userRoles).values([
      { roleId: role!.id, userId, workspaceId: null },
      { roleId: role!.id, userId: otherUserId, workspaceId: null },
    ]);
    await serverDB.update(users).set({ banned: true }).where(eq(users.id, otherUserId));
    expect(await rbac.countActiveSuperAdmins()).toBe(1);
  });

  it('replaceGlobalUserRoles refuses to remove the last non-banned super_admin (M1)', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const role = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    await serverDB.insert(userRoles).values({ roleId: role!.id, userId, workspaceId: null });

    await expect(rbac.replaceGlobalUserRoles(userId, [])).rejects.toMatchObject({
      code: 'PLATFORM_LAST_SUPER_ADMIN',
    });
    expect(await rbac.isGlobalSuperAdmin(userId)).toBe(true);
  });

  it('M04: rejects finite expiresAt with super_admin (permanent only)', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const role = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    await expect(
      rbac.replaceGlobalUserRoles(userId, [role!.id], {
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toThrow(/PLATFORM_INVALID_INPUT/);
  });

  it('M04: countActiveSuperAdmins treats expired temporary ban as active', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const role = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    await serverDB.insert(userRoles).values([
      { roleId: role!.id, userId, workspaceId: null },
      { roleId: role!.id, userId: otherUserId, workspaceId: null },
    ]);
    await serverDB
      .update(users)
      .set({ banExpires: new Date(Date.now() - 1000), banned: true })
      .where(eq(users.id, otherUserId));
    // expired temp ban → effectively active → still counted
    expect(await rbac.countActiveSuperAdmins()).toBe(2);
  });

  it('M04: expiring-only super grants do not count as permanent active supers', async () => {
    const rbac = new RbacModel(serverDB, userId);
    const role = await serverDB.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    // Permanent super on userId
    await serverDB.insert(userRoles).values({ roleId: role!.id, userId, workspaceId: null });
    // Simulated legacy row with expiresAt (should not count)
    await serverDB.insert(userRoles).values({
      expiresAt: new Date(Date.now() + 86_400_000),
      roleId: role!.id,
      userId: otherUserId,
      workspaceId: null,
    });
    expect(await rbac.countActiveSuperAdmins()).toBe(1);
  });
});
