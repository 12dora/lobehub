// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { permissions, rolePermissions, roles, userRoles, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';

import { ensureDefaultPlatformUserRole } from './ensureDefaultRole';

const db: LobeChatDatabase = await getTestDB();
const userId = 'ensure-default-role-user';

const cleanup = async () => {
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values({ id: userId });
  await seedPlatformRoles(db);
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('ensureDefaultPlatformUserRole', () => {
  it('grants platform_user when the user has no global roles', async () => {
    await ensureDefaultPlatformUserRole(db, userId);

    const platformUser = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.PLATFORM_USER), isNull(t.workspaceId)),
    });
    const grants = await db.query.userRoles.findMany({
      where: (t, { eq }) => eq(t.userId, userId),
    });
    expect(grants.map((g) => g.roleId)).toEqual([platformUser!.id]);
  });

  it('does not re-grant when the user already has a global role', async () => {
    const auditor = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.AUDITOR), isNull(t.workspaceId)),
    });
    await db.insert(userRoles).values({
      roleId: auditor!.id,
      userId,
      workspaceId: null,
    });

    await ensureDefaultPlatformUserRole(db, userId);

    const grants = await db.query.userRoles.findMany({
      where: (t, { eq }) => eq(t.userId, userId),
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]?.roleId).toBe(auditor!.id);
  });

  it('swallows errors so login is never blocked', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seedUtils = await import('../../utils/seedPlatformRoles');
    const seedSpy = vi
      .spyOn(seedUtils, 'ensurePlatformPermissionsExist')
      .mockRejectedValueOnce(new Error('seed boom'));

    await expect(ensureDefaultPlatformUserRole(db, userId)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    seedSpy.mockRestore();
  });
});
