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
    const result = await ensureDefaultPlatformUserRole(db, userId);
    expect(result).toEqual({ status: 'assigned' });

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

    const result = await ensureDefaultPlatformUserRole(db, userId);
    expect(result).toEqual({ status: 'alreadyAssigned' });

    const grants = await db.query.userRoles.findMany({
      where: (t, { eq }) => eq(t.userId, userId),
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]?.roleId).toBe(auditor!.id);
  });

  it('does not invoke RBAC seed when the user already has a global role (DB-004 hot path)', async () => {
    const auditor = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.AUDITOR), isNull(t.workspaceId)),
    });
    await db.insert(userRoles).values({
      roleId: auditor!.id,
      userId,
      workspaceId: null,
    });

    const seedUtils = await import('../../utils/seedPlatformRoles');
    const seedSpy = vi.spyOn(seedUtils, 'seedPlatformRoles');
    const permsSpy = vi.spyOn(seedUtils, 'ensurePlatformPermissionsExist');

    const result = await ensureDefaultPlatformUserRole(db, userId);
    expect(result).toEqual({ status: 'alreadyAssigned' });
    expect(seedSpy).not.toHaveBeenCalled();
    expect(permsSpy).not.toHaveBeenCalled();
  });

  it('returns retryRequired without throwing so login is never blocked', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seedUtils = await import('../../utils/seedPlatformRoles');
    const seedSpy = vi
      .spyOn(seedUtils, 'ensurePlatformPermissionsExist')
      .mockRejectedValueOnce(new Error('seed boom'));

    const result = await ensureDefaultPlatformUserRole(db, userId);
    expect(result).toEqual({
      errorCategory: 'Error',
      status: 'retryRequired',
    });
    expect(consoleSpy).toHaveBeenCalled();
    seedSpy.mockRestore();
  });

  it('repairs after a first-call failure so exactly one platform_user grant exists', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seedUtils = await import('../../utils/seedPlatformRoles');
    const seedSpy = vi
      .spyOn(seedUtils, 'ensurePlatformPermissionsExist')
      .mockRejectedValueOnce(new Error('transient seed boom'));

    const first = await ensureDefaultPlatformUserRole(db, userId);
    expect(first.status).toBe('retryRequired');

    seedSpy.mockRestore();

    const second = await ensureDefaultPlatformUserRole(db, userId);
    expect(second).toEqual({ status: 'assigned' });

    const platformUser = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.PLATFORM_USER), isNull(t.workspaceId)),
    });
    const grants = await db.query.userRoles.findMany({
      where: (t, { eq }) => eq(t.userId, userId),
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]?.roleId).toBe(platformUser!.id);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('returns skipped for empty userId', async () => {
    await expect(ensureDefaultPlatformUserRole(db, '')).resolves.toEqual({ status: 'skipped' });
  });
});
