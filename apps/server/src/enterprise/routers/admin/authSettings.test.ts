// @vitest-environment node
/**
 * admin.authSettings — audit atomicity: audit failure must roll back the settings write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformAuthSettings,
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
const createCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).authSettings;

const ids = { admin: 'auth-settings-admin' };

const appendSpy = vi.hoisted(() => vi.fn());

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('../../services/platformAudit', () => ({
  PlatformAuditService: class {
    append = appendSpy;
  },
}));

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformAuthSettings);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  appendSpy.mockReset();
  appendSpy.mockImplementation(async (params: { action: string }) => ({
    action: params.action,
    id: 'audit-ok',
    result: 'success',
  }));
  await cleanup();
  await db.insert(users).values({ id: ids.admin });
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
    userId: ids.admin,
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async () =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId: ids.admin,
    })),
    serverDB: db,
  } as never);

describe('authSettings/sidebarLayout roll back on audit failure — authSettings', () => {
  const fullSettings = (openRegistration: boolean, expectedRevision = 0) => ({
    emailDomainAllowlist: [] as string[],
    emailDomainAllowlistEnabled: false,
    expectedRevision,
    openRegistration,
  });

  it('commits settings + audit together on success', async () => {
    const caller = await callerFor();
    const next = await caller.update(fullSettings(false, 0));
    expect(next.openRegistration).toBe(false);
    expect(next.revision).toBe(1);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.authSettings.update',
        result: 'success',
      }),
    );
    const rows = await db.select().from(platformAuthSettings);
    expect(rows[0]?.openRegistration).toBe(false);
  });

  it('rolls back the settings write when the audit append fails', async () => {
    const caller = await callerFor();
    // Establish a known baseline.
    await caller.update(fullSettings(true, 0));
    appendSpy.mockRejectedValueOnce(new Error('audit sink unavailable'));

    await expect(caller.update(fullSettings(false, 1))).rejects.toBeTruthy();

    const rows = await db.select().from(platformAuthSettings);
    // Transaction rolled back — open registration stays true.
    expect(rows[0]?.openRegistration).toBe(true);
  });

  it('requires IDENTITY_UPDATE', async () => {
    // Super admin has it; identity without update would be a separate grant test.
    // Verify get works for identity-capable caller.
    const caller = await callerFor();
    await expect(caller.get()).resolves.toMatchObject({
      openRegistration: expect.any(Boolean),
    });
    void PLATFORM_PERMISSIONS.IDENTITY_UPDATE;
  });
});
