// @vitest-environment node
/**
 * admin.sidebarLayout — audit atomicity + CAS conflict mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
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

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
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
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(ids) });
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
  it('commits layout + audit together on success and returns new revision', async () => {
    const caller = await callerFor();
    const next = await caller.update({
      expectedRevision: 0,
      layout: {
        hiddenSidebarSections: [],
        sidebarItems: ['home', 'chat'],
      },
      mode: 'platform',
    });
    expect(next.mode).toBe('platform');
    expect(next.revision).toBe(1);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.sidebarLayout.update',
        configRevision: 1,
        result: 'success',
      }),
    );
    const rows = await db.select().from(platformSidebarLayout);
    expect(rows[0]?.mode).toBe('platform');
    expect(rows[0]?.revision).toBe(1);
  });

  it('rolls back the layout write when the audit append fails', async () => {
    const caller = await callerFor();
    await caller.update({
      expectedRevision: 0,
      layout: null,
      mode: 'user',
    });
    appendSpy.mockRejectedValueOnce(new Error('audit sink unavailable'));

    await expect(
      caller.update({
        expectedRevision: 1,
        layout: {
          hiddenSidebarSections: ['a'],
          sidebarItems: ['x'],
        },
        mode: 'platform',
      }),
    ).rejects.toBeTruthy();

    const rows = await db.select().from(platformSidebarLayout);
    expect(rows[0]?.mode).toBe('user');
    expect(rows[0]?.revision).toBe(1);
  });

  it('maps stale expectedRevision to PLATFORM_REVISION_CONFLICT', async () => {
    const caller = await callerFor();
    await caller.update({
      expectedRevision: 0,
      layout: null,
      mode: 'user',
    });
    // Advance revision to 2.
    await caller.update({
      expectedRevision: 1,
      layout: {
        hiddenSidebarSections: [],
        sidebarItems: ['home'],
      },
      mode: 'platform',
    });

    await expect(
      caller.update({
        expectedRevision: 1,
        layout: null,
        mode: 'user',
      }),
    ).rejects.toMatchObject({
      cause: {
        data: {
          code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
        },
      },
      code: 'CONFLICT',
      message: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
    });

    const current = await caller.get();
    expect(current.mode).toBe('platform');
    expect(current.revision).toBe(2);
  });
});
