// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformModuleSettings,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { resetModuleSettingsForTest } from '../../services/moduleSettings';
import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(adminRouter);
const createModulesCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).modules;

const ids = { admin: 'admin-modules-router-admin' };

const appendSpy = vi.hoisted(() => vi.fn());

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('../../services/platformAudit', () => ({
  PlatformAuditService: class {
    append = appendSpy;
  },
}));

const stubEnterpriseOn = () => {
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  vi.stubEnv('ENABLE_PLATFORM_SETTINGS_POLICY', '1');
  vi.stubEnv('ENABLE_RUNTIME_BRANDING', '1');
  vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
};

const cleanup = async () => {
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(ids) });
  await db.delete(platformModuleSettings);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
  resetModuleSettingsForTest();
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  stubEnterpriseOn();
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

const callerFor = async (authenticatedAt: Date | null = new Date()) =>
  createModulesCaller({
    ...(await createContextInner({
      authenticatedAt,
      authMethod: 'better-auth',
      userId: ids.admin,
    })),
    serverDB: db,
  } as never);

describe('admin.modules', () => {
  it('get returns an all-on snapshot when the row is missing', async () => {
    const view = await (await callerFor()).get();
    expect(view.snapshot.db).toBeNull();
    expect(view.snapshot.revision).toBe(0);
    expect(view.snapshot.effective.audit).toBe(true);
    expect(view.snapshot.preset).toBe('full');
    expect(view.restart.supported).toBe(false);
    expect(view.instanceId).toMatch(/^pinst_/);
    expect(Array.isArray(view.pendingRestart)).toBe(true);
  });

  it('update persists a non-compliance patch without reauth and writes an audit row', async () => {
    const caller = await callerFor();
    const next = await caller.update({
      expectedRevision: 0,
      modules: { branding: false },
    });
    expect(next.snapshot.revision).toBe(1);
    expect(next.snapshot.effective.branding).toBe(false);
    expect(next.snapshot.effective.audit).toBe(true);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.modules.update',
        configRevision: 1,
        result: 'success',
      }),
    );
    const [row] = await db.select().from(platformModuleSettings);
    expect(row?.modules).toEqual({ branding: false });
    expect(row?.revision).toBe(1);
  });

  it('requires reauth when turning OFF audit even if the hot snapshot is stale', async () => {
    await db.insert(platformModuleSettings).values({
      id: 'global',
      modules: { audit: false },
      revision: 1,
    });
    // Populate the 30s cache with "audit already off".
    const warm = await (await callerFor()).get();
    expect(warm.snapshot.db).toEqual({ audit: false });

    await db
      .update(platformModuleSettings)
      .set({ modules: { audit: true }, revision: 2 })
      .where(eq(platformModuleSettings.id, 'global'));

    const stale = await callerFor(null);
    await expect(
      stale.update({ expectedRevision: 2, modules: { audit: false } }),
    ).rejects.toMatchObject({
      cause: { data: { code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED } },
      code: 'UNAUTHORIZED',
    });

    const [row] = await db.select().from(platformModuleSettings);
    expect(row?.modules).toEqual({ audit: true });
    expect(row?.revision).toBe(2);
  });

  it('maps a stale expectedRevision to PLATFORM_REVISION_CONFLICT', async () => {
    const caller = await callerFor();
    await caller.update({ expectedRevision: 0, modules: { branding: false } });
    await expect(
      caller.update({ expectedRevision: 0, modules: { branding: true } }),
    ).rejects.toMatchObject({
      cause: { data: { code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT } },
      code: 'CONFLICT',
    });
    const [row] = await db.select().from(platformModuleSettings);
    expect(row?.revision).toBe(1);
    expect(row?.modules).toEqual({ branding: false });
  });

  it('rolls back the settings write when the audit append fails', async () => {
    const caller = await callerFor();
    await caller.update({ expectedRevision: 0, modules: { branding: false } });
    appendSpy.mockRejectedValueOnce(new Error('audit sink unavailable'));

    await expect(
      caller.update({ expectedRevision: 1, modules: { branding: true } }),
    ).rejects.toBeTruthy();

    const [row] = await db.select().from(platformModuleSettings);
    expect(row?.modules).toEqual({ branding: false });
    expect(row?.revision).toBe(1);
  });

  it('requestRestart is unsupported in the test runtime', async () => {
    await expect((await callerFor()).requestRestart({})).rejects.toMatchObject({
      cause: { data: { code: PLATFORM_ERROR_CODES.PLATFORM_OIDC_RESTART_UNSUPPORTED } },
    });
  });
});
