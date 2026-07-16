// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { permissions, rolePermissions, roles, userRoles, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { authedProcedure, createCallerFactory, publicProcedure, router } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

const db: LobeChatDatabase = await getTestDB();
const userId = 'access-gate-user';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const businessRouter = router({
  businessPing: authedProcedure.query(() => ({ ok: true })),
  // allowlisted path name must match full procedure path when mounted
});

// Mount under `platform` so allowlist platform.getAccessStatus works via separate router
const platformish = router({
  getAccessStatus: authedProcedure.query(() => ({ accessGranted: false, reason: 'probe' })),
});

const root = router({
  biz: businessRouter,
  platform: platformish,
});

const createCaller = createCallerFactory(root);

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

describe('enterpriseAccessGate on authedProcedure (B3)', () => {
  it('flag off → business API allowed (upstream parity)', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    const caller = createCaller((await createContextInner({ userId })) as never);
    await expect(caller.biz.businessPing()).resolves.toEqual({ ok: true });
  });

  it('no access → business API PLATFORM_ACCESS_NOT_GRANTED', async () => {
    const caller = createCaller((await createContextInner({ userId })) as never);
    try {
      await caller.biz.businessPing();
      expect.fail('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('FORBIDDEN');
      expect((error as { message: string }).message).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_ACCESS_NOT_GRANTED,
      );
    }
  });

  it('super_admin → business API allowed', async () => {
    const role = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    await db.insert(userRoles).values({ roleId: role!.id, userId, workspaceId: null });
    const caller = createCaller((await createContextInner({ userId })) as never);
    await expect(caller.biz.businessPing()).resolves.toEqual({ ok: true });
  });

  it('allowlisted platform.getAccessStatus works without access', async () => {
    const caller = createCaller((await createContextInner({ userId })) as never);
    await expect(caller.platform.getAccessStatus()).resolves.toMatchObject({
      reason: 'probe',
    });
  });
});

// keep publicProcedure import used for type parity
void publicProcedure;
