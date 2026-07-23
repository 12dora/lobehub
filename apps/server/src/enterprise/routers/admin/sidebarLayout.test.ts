// @vitest-environment node
/**
 * admin.sidebarLayout — audit atomicity: audit failure must roll back the layout write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformSidebarLayout,
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
  createRootCaller(context).sidebarLayout;

const ids = { admin: 'sidebar-layout-admin' };

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
  await db.delete(platformSidebarLayout);
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

describe('authSettings/sidebarLayout roll back on audit failure — sidebarLayout', () => {
  it('commits layout + audit together on success', async () => {
    const caller = await callerFor();
    const next = await caller.update({
      layout: {
        hiddenSidebarSections: [],
        sidebarItems: ['home', 'chat'],
      },
      mode: 'platform',
    });
    expect(next.mode).toBe('platform');
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.sidebarLayout.update',
        result: 'success',
      }),
    );
    const rows = await db.select().from(platformSidebarLayout);
    expect(rows[0]?.mode).toBe('platform');
  });

  it('rolls back the layout write when the audit append fails', async () => {
    const caller = await callerFor();
    await caller.update({
      layout: null,
      mode: 'user',
    });
    appendSpy.mockRejectedValueOnce(new Error('audit sink unavailable'));

    await expect(
      caller.update({
        layout: {
          hiddenSidebarSections: ['a'],
          sidebarItems: ['x'],
        },
        mode: 'platform',
      }),
    ).rejects.toBeTruthy();

    const rows = await db.select().from(platformSidebarLayout);
    expect(rows[0]?.mode).toBe('user');
  });
});
