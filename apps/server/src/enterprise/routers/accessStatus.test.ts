// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { permissions, rolePermissions, roles, userRoles, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { platformRouter } from './platform';

const db: LobeChatDatabase = await getTestDB();
const userId = 'access-status-user';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const createCaller = createCallerFactory(platformRouter);

const cleanup = async () => {
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
  await db.insert(users).values({ id: userId });
  await seedPlatformRoles(db);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('platform.getAccessStatus', () => {
  it('flag off → access granted (upstream parity)', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    const ctx = { ...(await createContextInner({ userId })), serverDB: db } as never;
    const status = await createCaller(ctx).getAccessStatus();
    expect(status.accessGranted).toBe(true);
    expect(status.reason).toBe('feature_disabled');
  });

  it('super_admin → access granted', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    const role = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    await db.insert(userRoles).values({ roleId: role!.id, userId, workspaceId: null });

    const ctx = { ...(await createContextInner({ userId })), serverDB: db } as never;
    const status = await createCaller(ctx).getAccessStatus();
    expect(status.accessGranted).toBe(true);
    expect(status.reason).toBe('super_admin');
  });

  it('authenticated non-admin → access granted (Authentik-only admission)', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    const ctx = { ...(await createContextInner({ userId })), serverDB: db } as never;
    const status = await createCaller(ctx).getAccessStatus();
    expect(status.accessGranted).toBe(true);
    expect(status.reason).toBe('granted');
    expect(status.permissionRequestUrl).toBeNull();
  });

  it('getCapabilities adminAccess true for super_admin when flag on', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    const role = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    await db.insert(userRoles).values({ roleId: role!.id, userId, workspaceId: null });

    const ctx = { ...(await createContextInner({ userId })), serverDB: db } as never;
    const caps = await createCaller(ctx).getCapabilities();
    expect(caps.adminAccess).toBe(true);
  });
});
