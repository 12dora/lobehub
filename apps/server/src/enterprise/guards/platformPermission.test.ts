// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { permissions, rolePermissions, roles, userRoles, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { authedProcedure, createCallerFactory, router } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { getEnterpriseErrorBody } from './enterpriseErrors';
import { withPlatformPermission } from './platformPermission';

const db: LobeChatDatabase = await getTestDB();
const userId = 'guard-user';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const testRouter = router({
  needsUserBan: authedProcedure
    .use(serverDatabase)
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .query(() => ({ ok: true })),
});

const createCaller = createCallerFactory(testRouter);

const cleanup = async () => {
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
  await db.insert(users).values({ id: userId });
  await seedPlatformRoles(db);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('withPlatformPermission', () => {
  it('allows when user has the global permission', async () => {
    const role = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.USER_ADMIN), isNull(t.workspaceId)),
    });
    await db.insert(userRoles).values({ roleId: role!.id, userId, workspaceId: null });

    const ctx = { ...(await createContextInner({ userId })), serverDB: db } as never;
    const caller = createCaller(ctx);
    await expect(caller.needsUserBan()).resolves.toEqual({ ok: true });
  });

  it('denies with structured PLATFORM_PERMISSION_DENIED', async () => {
    // Grant base access so enterpriseAccessGate passes; permission check should still fail.
    const accessRole = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.PLATFORM_USER), isNull(t.workspaceId)),
    });
    await db.insert(userRoles).values({ roleId: accessRole!.id, userId, workspaceId: null });

    const ctx = { ...(await createContextInner({ userId })), serverDB: db } as never;
    const caller = createCaller(ctx);
    try {
      await caller.needsUserBan();
      expect.fail('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('FORBIDDEN');
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      );
    }
  });

  it('feature flag off → ADMIN_FEATURE_DISABLED', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    const ctx = { ...(await createContextInner({ userId })), serverDB: db } as never;
    const caller = createCaller(ctx);
    await expect(caller.needsUserBan()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
