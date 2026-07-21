// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformEasyauthGrantSnapshots,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { adminEasyauthRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const actorUserId = 'easyauth-reauth-admin';
const readerUserId = 'easyauth-status-reader';
const deniedUserId = 'easyauth-status-denied';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await db.delete(platformEasyauthGrantSnapshots);
  await db.delete(platformAuditLogs);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
  await db.insert(users).values([{ id: actorUserId }, { id: readerUserId }, { id: deniedUserId }]);
  await seedPlatformRoles(db);
  const superAdmin = await db.query.roles.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(table.workspaceId)),
  });
  await db.insert(userRoles).values({
    roleId: superAdmin!.id,
    userId: actorUserId,
    workspaceId: null,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
  vi.unstubAllEnvs();
});

const caller = async (auth: {
  authenticatedAt?: Date | null;
  authMethod?: 'api-key' | 'better-auth';
  userId?: string;
}) =>
  adminEasyauthRouter.createCaller({
    ...(await createContextInner({
      authenticatedAt: auth.authenticatedAt,
      authMethod: auth.authMethod ?? 'better-auth',
      userId: auth.userId ?? actorUserId,
    })),
    serverDB: db,
  } as never);

describe('admin.easyauth.triggerSync recent reauth', () => {
  it('rejects missing, stale and API-key auth before EasyAuth state writes', async () => {
    const input = { reason: 'manually reconcile managed roles', userId: actorUserId };
    const initialAssignments = await db.select().from(userRoles);

    for (const auth of [
      { authenticatedAt: null, authMethod: 'better-auth' as const },
      {
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth' as const,
      },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ]) {
      await expect((await caller(auth)).triggerSync(input)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }

    await expect(db.select().from(platformEasyauthGrantSnapshots)).resolves.toEqual([]);
    await expect(db.select().from(userRoles)).resolves.toEqual(initialAssignments);
    const denied = (await db.select().from(platformAuditLogs)).filter(
      ({ action }) => action === 'admin.easyauth.triggerSync',
    );
    expect(denied).toHaveLength(3);
    expect(denied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          afterDiff: { error: 'reauth_required' },
          reason: input.reason,
          result: 'denied',
        }),
      ]),
    );
  });

  it('never persists a raw secret-like reason in the reauth-denied audit', async () => {
    const rawReason = 'Authorization: Bearer test-only-easyauth-credential';
    await expect(
      (await caller({ authenticatedAt: null })).triggerSync({
        reason: rawReason,
        userId: actorUserId,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const [denied] = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.easyauth.triggerSync'));
    expect(denied).toMatchObject({
      reason: 'easyauth_sync_invalid_reason',
      result: 'denied',
    });
    expect(JSON.stringify(denied)).not.toContain(rawReason);
    await expect(db.select().from(platformEasyauthGrantSnapshots)).resolves.toEqual([]);
  });

  it('stays denied when the denied audit sink fails and logs no input or target ID', async () => {
    const reason = 'reconcile after access review';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const insert = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('audit sink unavailable');
    });

    await expect(
      (await caller({ authenticatedAt: null })).triggerSync({ reason, userId: actorUserId }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      new RegExp(`${reason}|${actorUserId}`),
    );
    await expect(db.select().from(platformEasyauthGrantSnapshots)).resolves.toEqual([]);
    insert.mockRestore();
    consoleError.mockRestore();
  });

  it('allows a fresh interactive session to reach the existing sync service', async () => {
    await expect(
      (await caller({ authenticatedAt: new Date() })).triggerSync({
        reason: 'fresh EasyAuth reconciliation',
        userId: actorUserId,
      }),
    ).resolves.toMatchObject({
      accessGranted: true,
      degraded: false,
      rolesApplied: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
      source: 'super_admin_bypass',
    });
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'platform.easyauth.sync', result: 'success' }),
    );
  });
});

describe('admin.easyauth.getStatus', () => {
  it('requires IDENTITY_READ and never returns token material', async () => {
    const secretToken = 'eat_test_only_do_not_leak';
    vi.stubEnv('EASYAUTH_APP_TOKEN', secretToken);
    vi.stubEnv('EASYAUTH_BASE_URL', 'https://easyauth.example');
    vi.stubEnv('EASYAUTH_APP_KEY', 'aihub');
    vi.stubEnv('EASYAUTH_PORTAL_URL', 'https://portal.example');

    await expect((await caller({ userId: deniedUserId })).getStatus()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const status = await (await caller({ userId: actorUserId })).getStatus();
    expect(status).toMatchObject({
      config: {
        appKey: 'aihub',
        baseUrl: 'https://easyauth.example',
        portalUrl: 'https://portal.example',
        tokenConfigured: true,
      },
      sync: {
        accessGrantedCount: 0,
        degradedCount: 0,
        latestFetchedAt: null,
        totalCount: 0,
      },
    });
    expect(JSON.stringify(status)).not.toContain(secretToken);
    expect(status).not.toHaveProperty('appToken');
    expect(status.config).not.toHaveProperty('appToken');
  });

  it('aggregates grant snapshot totals without secrets', async () => {
    const secretToken = 'eat_aggregate_must_stay_out';
    vi.stubEnv('EASYAUTH_APP_TOKEN', secretToken);
    vi.stubEnv('EASYAUTH_APP_KEY', 'aihub');
    const fetchedAt = new Date('2026-03-01T12:00:00.000Z');
    await db.insert(platformEasyauthGrantSnapshots).values([
      {
        accessGranted: true,
        appKey: 'aihub',
        catalogVersion: 1,
        degraded: false,
        externalUserId: 'ext-1',
        fetchedAt,
        grantVersion: 1,
        grants: [],
        groups: [],
        snapshotVersion: '1',
        userId: actorUserId,
      },
      {
        accessGranted: false,
        appKey: 'aihub',
        catalogVersion: 1,
        degraded: true,
        externalUserId: 'ext-2',
        fetchedAt: new Date('2026-02-01T00:00:00.000Z'),
        grantVersion: 1,
        grants: [],
        groups: [],
        lastError: 'upstream timeout',
        snapshotVersion: '1',
        userId: readerUserId,
      },
      {
        accessGranted: true,
        appKey: 'other-app',
        catalogVersion: 1,
        degraded: true,
        externalUserId: 'ext-3',
        fetchedAt: new Date('2026-04-01T00:00:00.000Z'),
        grantVersion: 1,
        grants: [],
        groups: [],
        snapshotVersion: '1',
        userId: deniedUserId,
      },
    ]);

    const status = await (await caller({ userId: actorUserId })).getStatus();
    expect(status.sync).toEqual({
      accessGrantedCount: 1,
      degradedCount: 1,
      latestFetchedAt: fetchedAt,
      totalCount: 2,
    });
    expect(JSON.stringify(status)).not.toContain(secretToken);
    expect(JSON.stringify(status)).not.toContain('upstream timeout');
  });

  it('reports tokenConfigured=false when no token is available', async () => {
    vi.stubEnv('EASYAUTH_APP_TOKEN', '');
    vi.stubEnv('EASYAUTH_APP_TOKEN_FILE', '/nonexistent/easyauth-token-file');
    const status = await (await caller({ userId: actorUserId })).getStatus();
    expect(status.config.tokenConfigured).toBe(false);
  });
});
