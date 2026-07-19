// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AIHUB_ACCESS_PERMISSION } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { RbacModel } from '@/database/models/rbac';
import { permissions, rolePermissions, roles, userRoles, users } from '@/database/schemas';
import { platformAuditLogs, platformEasyauthGrantSnapshots } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';

import { EasyauthPermissionClient, type EasyauthPermissionSnapshot } from './easyauthClient';
import {
  deriveManagedRolesFromSnapshot,
  EasyauthSyncService,
  snapshotHasAccess,
} from './easyauthSync';
import { PlatformAuditService } from './platformAudit';

const db: LobeChatDatabase = await getTestDB();
const userId = 'easyauth-sync-user';

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformEasyauthGrantSnapshots);
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
});

const sampleSnapshot = (
  overrides: Partial<EasyauthPermissionSnapshot> = {},
): EasyauthPermissionSnapshot => ({
  app_key: 'aihub',
  catalog_version: 1,
  grant_version: 3,
  grants: [{ permission: AIHUB_ACCESS_PERMISSION, scope: 'ALL' }],
  groups: [{ key: 'user_admin', kind: 'role', name: 'User Admin' }],
  snapshot_version: 'sv-1',
  user_id: 'ak_uid_1',
  ...overrides,
});

describe('EasyauthSyncService', () => {
  it('maps groups and grants to managed roles', () => {
    const rolesFromSnap = deriveManagedRolesFromSnapshot(sampleSnapshot());
    expect(rolesFromSnap).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
    expect(rolesFromSnap).toContain(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
    expect(snapshotHasAccess(sampleSnapshot())).toBe(true);
  });

  it('syncUser applies roles idempotently and preserves super_admin', async () => {
    const rbac = new RbacModel(db, userId);
    const superRole = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    await db.insert(userRoles).values({
      roleId: superRole!.id,
      userId,
      workspaceId: null,
    });

    const fetch = vi.fn(async () => sampleSnapshot());
    const client = new EasyauthPermissionClient({
      config: {
        appKey: 'aihub',
        appToken: 'eat_fake_test_token_not_real',
        baseUrl: 'https://easyauth.test',
        descriptorToken: null,
        manifestSchemaVersion: 1,
        portalUrl: 'https://easyauth.test',
        timeoutMs: 1000,
      },
      fetchImpl: async () =>
        new Response(JSON.stringify(sampleSnapshot()), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
    });
    // Override client method
    client.fetchPermissionSnapshot = fetch;

    const service = new EasyauthSyncService(db, { client });
    // super_admin bypasses EasyAuth
    const result = await service.syncUser({
      externalUserId: 'ak_uid_1',
      userId,
    });
    expect(result.source).toBe('super_admin_bypass');
    expect(await rbac.isGlobalSuperAdmin(userId)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await expect(db.select().from(platformAuditLogs)).resolves.toMatchObject([
      {
        action: 'platform.easyauth.sync',
        afterDiff: { source: 'super_admin_bypass' },
        result: 'success',
      },
    ]);
  });

  it('syncUser writes snapshot and global roles for normal user', async () => {
    const client = new EasyauthPermissionClient({
      config: {
        appKey: 'aihub',
        appToken: 'eat_fake_test_token_not_real',
        baseUrl: 'https://easyauth.test',
        descriptorToken: null,
        manifestSchemaVersion: 1,
        portalUrl: 'https://easyauth.test',
        timeoutMs: 1000,
      },
    });
    client.fetchPermissionSnapshot = vi.fn(async () => sampleSnapshot());

    const service = new EasyauthSyncService(db, { client });
    const result = await service.syncUser({
      externalUserId: 'ak_uid_1',
      reason: 'login',
      userId,
    });

    expect(result.source).toBe('easyauth');
    expect(result.accessGranted).toBe(true);
    expect(result.rolesApplied).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);
    expect(result.grantVersion).toBe(3);

    // second sync is idempotent
    const again = await service.syncUser({
      externalUserId: 'ak_uid_1',
      userId,
    });
    expect(again.rolesApplied).toContain(PLATFORM_SYSTEM_ROLES.USER_ADMIN);

    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toHaveLength(2);
    expect(audits.at(-1)).toMatchObject({
      afterDiff: { source: 'unchanged' },
      result: 'success',
    });

    const rbac = new RbacModel(db, userId);
    expect(await rbac.hasGlobalPermission('platform_user:ban:all', userId)).toBe(true);
  });

  it('rolls back snapshot and roles when the success outcome audit cannot commit', async () => {
    const client = new EasyauthPermissionClient({
      config: {
        appKey: 'aihub',
        appToken: 'eat_fake_test_token_not_real',
        baseUrl: 'https://easyauth.test',
        descriptorToken: null,
        manifestSchemaVersion: 1,
        portalUrl: 'https://easyauth.test',
        timeoutMs: 1000,
      },
    });
    client.fetchPermissionSnapshot = vi.fn(async () => sampleSnapshot());
    const auditWriter = vi.fn(async (auditDb, params) => {
      await new PlatformAuditService(auditDb).append(params);
      throw new Error('simulated audit outage');
    });

    await expect(
      new EasyauthSyncService(db, { auditWriter, client }).syncUser({
        actorUserId: 'admin-user',
        externalUserId: 'ak_uid_1',
        reason: 'role repair',
        userId,
      }),
    ).rejects.toThrow('PLATFORM_EASYAUTH_AUDIT_UNAVAILABLE');

    expect(auditWriter).toHaveBeenCalledTimes(1);
    expect(auditWriter.mock.calls[0]?.[1]).toMatchObject({
      afterDiff: { source: 'easyauth' },
      result: 'success',
    });
    await expect(db.select().from(platformEasyauthGrantSnapshots)).resolves.toEqual([]);
    await expect(db.select().from(userRoles)).resolves.toEqual([]);
    await expect(db.select().from(platformAuditLogs)).resolves.toEqual([]);
  });

  it('degrades to cache when EasyAuth is unreachable', async () => {
    const client = new EasyauthPermissionClient({
      config: {
        appKey: 'aihub',
        appToken: 'eat_fake_test_token_not_real',
        baseUrl: 'https://easyauth.test',
        descriptorToken: null,
        manifestSchemaVersion: 1,
        portalUrl: 'https://easyauth.test',
        timeoutMs: 1000,
      },
    });
    client.fetchPermissionSnapshot = vi
      .fn()
      .mockResolvedValueOnce(sampleSnapshot())
      .mockRejectedValueOnce(new Error('network down'));

    const service = new EasyauthSyncService(db, { client });
    await service.syncUser({ externalUserId: 'ak_uid_1', userId });

    const degraded = await service.syncUser({ externalUserId: 'ak_uid_1', userId });
    expect(degraded.degraded).toBe(true);
    expect(degraded.accessGranted).toBe(true);
    expect(degraded.source).toBe('cache');
    const audits = await db.select().from(platformAuditLogs);
    expect(audits.at(-1)).toMatchObject({
      afterDiff: { degraded: true, source: 'cache' },
      result: 'failure',
    });
    expect(JSON.stringify(audits)).not.toContain('network down');
  });

  it('rolls back the degraded snapshot when its outcome audit cannot commit', async () => {
    const client = new EasyauthPermissionClient({
      config: {
        appKey: 'aihub',
        appToken: 'eat_fake_test_token_not_real',
        baseUrl: 'https://easyauth.test',
        descriptorToken: null,
        manifestSchemaVersion: 1,
        portalUrl: 'https://easyauth.test',
        timeoutMs: 1000,
      },
    });
    client.fetchPermissionSnapshot = vi.fn(async () => sampleSnapshot());
    await new EasyauthSyncService(db, { client }).syncUser({
      externalUserId: 'ak_uid_1',
      reason: 'initial sync',
      userId,
    });

    client.fetchPermissionSnapshot = vi.fn(async () => {
      throw new Error('private upstream detail');
    });
    const auditWriter = vi.fn(async (auditDb, params) => {
      await new PlatformAuditService(auditDb).append(params);
      throw new Error('simulated degraded audit outage');
    });
    await expect(
      new EasyauthSyncService(db, { auditWriter, client }).syncUser({
        externalUserId: 'ak_uid_1',
        reason: 'degraded retry',
        userId,
      }),
    ).rejects.toThrow('PLATFORM_EASYAUTH_AUDIT_UNAVAILABLE');

    expect(auditWriter).toHaveBeenCalledTimes(1);
    expect(auditWriter.mock.calls[0]?.[1]).toMatchObject({
      afterDiff: { degraded: true, source: 'cache' },
      result: 'failure',
    });
    await expect(db.select().from(platformEasyauthGrantSnapshots)).resolves.toMatchObject([
      { degraded: false, lastError: null },
    ]);
    await expect(db.select().from(platformAuditLogs)).resolves.toHaveLength(1);
    const rbac = new RbacModel(db, userId);
    await expect(rbac.hasGlobalPermission('platform_user:ban:all', userId)).resolves.toBe(true);
  });

  it('audits a fail-closed cache result when no prior snapshot exists', async () => {
    const client = new EasyauthPermissionClient({
      config: {
        appKey: 'aihub',
        appToken: 'eat_fake_test_token_not_real',
        baseUrl: 'https://easyauth.test',
        descriptorToken: null,
        manifestSchemaVersion: 1,
        portalUrl: 'https://easyauth.test',
        timeoutMs: 1000,
      },
    });
    client.fetchPermissionSnapshot = vi.fn(async () => {
      throw new Error('private upstream detail');
    });

    const outcome = await new EasyauthSyncService(db, { client }).syncUser({
      actorUserId: 'admin-user',
      externalUserId: 'ak_uid_1',
      reason: '  manual recovery  ',
      userId,
    });

    expect(outcome).toMatchObject({ accessGranted: false, degraded: true, source: 'cache' });
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toMatchObject([
      {
        actorUserId: 'admin-user',
        afterDiff: { degraded: true, source: 'cache' },
        reason: 'manual recovery',
        result: 'failure',
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('private upstream detail');
  });

  it('rejects credential-like reasons and persists only a stable safe failure reason', async () => {
    const client = new EasyauthPermissionClient({
      config: {
        appKey: 'aihub',
        appToken: 'eat_fake_test_token_not_real',
        baseUrl: 'https://easyauth.test',
        descriptorToken: null,
        manifestSchemaVersion: 1,
        portalUrl: 'https://easyauth.test',
        timeoutMs: 1000,
      },
    });
    const fetch = vi.fn(async () => sampleSnapshot());
    client.fetchPermissionSnapshot = fetch;
    const service = new EasyauthSyncService(db, { client });
    const unsafeReasons = [
      'token=opaque-value',
      'password=hunter2',
      'client_secret=opaque-value',
      'private key=opaque-value',
    ];

    for (const reason of unsafeReasons) {
      await expect(
        service.syncUser({ actorUserId: 'admin-user', externalUserId: 'ak_uid_1', reason, userId }),
      ).rejects.toThrow('PLATFORM_EASYAUTH_INVALID_REASON');
    }

    expect(fetch).not.toHaveBeenCalled();
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toHaveLength(unsafeReasons.length);
    expect(audits).toEqual(
      expect.arrayContaining(
        unsafeReasons.map(() =>
          expect.objectContaining({
            actorUserId: 'admin-user',
            afterDiff: { source: 'failed' },
            reason: 'easyauth_sync_invalid_reason',
            result: 'failure',
          }),
        ),
      ),
    );
    const serialized = JSON.stringify(audits);
    for (const reason of unsafeReasons) expect(serialized).not.toContain(reason);
  });

  it('writes a minimized failure audit when a management sync throws', async () => {
    const client = new EasyauthPermissionClient({
      config: {
        appKey: 'aihub',
        appToken: 'eat_fake_test_token_not_real',
        baseUrl: 'https://easyauth.test',
        descriptorToken: null,
        manifestSchemaVersion: 1,
        portalUrl: 'https://easyauth.test',
        timeoutMs: 1000,
      },
    });
    client.fetchPermissionSnapshot = vi.fn(async () => sampleSnapshot());

    await expect(
      new EasyauthSyncService(db, { client }).syncUser({
        actorUserId: 'admin-user',
        externalUserId: 'ak_uid_missing',
        reason: 'failed management sync',
        userId: 'missing-user',
      }),
    ).rejects.toBeDefined();

    await expect(db.select().from(platformAuditLogs)).resolves.toMatchObject([
      {
        actorUserId: 'admin-user',
        afterDiff: { source: 'failed' },
        reason: 'failed management sync',
        result: 'failure',
        targetId: 'missing-user',
      },
    ]);
  });

  it('audits a skipped result when no external identity or cache exists', async () => {
    const service = new EasyauthSyncService(db, {
      client: new EasyauthPermissionClient({
        config: {
          appKey: 'aihub',
          appToken: 'eat_fake_test_token_not_real',
          baseUrl: 'https://easyauth.test',
          descriptorToken: null,
          manifestSchemaVersion: 1,
          portalUrl: 'https://easyauth.test',
          timeoutMs: 1000,
        },
      }),
    });

    await expect(service.syncUser({ actorUserId: 'admin-user', userId })).resolves.toMatchObject({
      accessGranted: false,
      source: 'skipped',
    });
    await expect(db.select().from(platformAuditLogs)).resolves.toMatchObject([
      {
        actorUserId: 'admin-user',
        afterDiff: { source: 'skipped' },
        result: 'failure',
      },
    ]);
  });

  it('revokes managed roles when EasyAuth returns empty grants', async () => {
    const client = new EasyauthPermissionClient({
      config: {
        appKey: 'aihub',
        appToken: 'eat_fake_test_token_not_real',
        baseUrl: 'https://easyauth.test',
        descriptorToken: null,
        manifestSchemaVersion: 1,
        portalUrl: 'https://easyauth.test',
        timeoutMs: 1000,
      },
    });
    client.fetchPermissionSnapshot = vi
      .fn()
      .mockResolvedValueOnce(sampleSnapshot())
      .mockResolvedValueOnce(sampleSnapshot({ grant_version: 4, grants: [], groups: [] }));

    const service = new EasyauthSyncService(db, { client });
    await service.syncUser({ externalUserId: 'ak_uid_1', userId });
    const after = await service.syncUser({ externalUserId: 'ak_uid_1', userId });
    expect(after.accessGranted).toBe(false);
    expect(after.rolesApplied).toEqual([]);

    const rbac = new RbacModel(db, userId);
    expect(await rbac.hasGlobalPermission('platform_user:ban:all', userId)).toBe(false);
  });
});
