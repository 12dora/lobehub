// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { getServerDB } from '@/database/core/db-adaptor';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  platformInfraSettings,
  platformJobs,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(adminRouter);
const ids = { operator: 'm11-system-operator', reader: 'm11-system-reader' };
const roleName = 'm11_oidc_restart_operator';
const readerRoleName = 'm11_system_unrelated_reader';

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));
vi.mock('../../services/infraSettings/destinationPolicy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    assertInfraDestinationAllowed: vi.fn(async () => undefined),
    assertMailDestinationsAllowed: vi.fn(async () => undefined),
    assertObjectStorageDestinationsAllowed: vi.fn(async () => undefined),
  };
});

const cleanup = async () => {
  await db.delete(platformIdentityProviderRestartRequests);
  await db.delete(platformIdentityProviderInstances);
  await db.delete(platformJobs);
  await db.delete(platformInfraSettings);
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(ids) });
  const ownedRoles = await db
    .select({ id: roles.id })
    .from(roles)
    .where(inArray(roles.name, [readerRoleName, roleName]));
  if (ownedRoles.length > 0) {
    const roleIds = ownedRoles.map(({ id }) => id);
    await db.delete(userRoles).where(inArray(userRoles.roleId, roleIds));
    await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await db.delete(roles).where(inArray(roles.id, roleIds));
  }
  await db.delete(users).where(sql`${users.id} LIKE 'm11-system-%'`);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  const [role] = await db
    .insert(roles)
    .values({ displayName: roleName, name: roleName })
    .returning();
  const grantedPermissions = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      inArray(permissions.code, [
        PLATFORM_PERMISSIONS.OIDC_PUBLISH,
        PLATFORM_PERMISSIONS.SYSTEM_OPERATE,
        PLATFORM_PERMISSIONS.SYSTEM_READ,
      ]),
    );
  await db
    .insert(rolePermissions)
    .values(grantedPermissions.map(({ id }) => ({ permissionId: id, roleId: role.id })));
  await db.insert(userRoles).values({ roleId: role.id, userId: ids.operator, workspaceId: null });
  const [readerRole] = await db
    .insert(roles)
    .values({ displayName: readerRoleName, name: readerRoleName })
    .returning();
  const [readerPermission] = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.code, PLATFORM_PERMISSIONS.AUDIT_READ));
  await db
    .insert(rolePermissions)
    .values({ permissionId: readerPermission.id, roleId: readerRole.id });
  await db
    .insert(userRoles)
    .values({ roleId: readerRole.id, userId: ids.reader, workspaceId: null });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (userId: string, authenticatedAt = new Date()) => {
  const context = await createContextInner({
    authenticatedAt,
    authMethod: 'better-auth',
    sessionId: `session-${userId}`,
    userId,
  });
  return createCaller({ ...context, serverDB: db } as never).system;
};

describe('admin.system OIDC restart gate', () => {
  it('requires the dedicated platform_oidc:publish:all permission', async () => {
    const reader = await callerFor(ids.reader);
    await expect(reader.getAuthSnapshotStatus()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects at the feature flag before DB and RBAC access', async () => {
    const operator = await callerFor(ids.operator);
    vi.stubEnv('ENABLE_DATABASE_OIDC', '0');
    vi.mocked(getServerDB).mockClear();
    const select = vi.spyOn(db, 'select');
    await expect(operator.getAuthSnapshotStatus()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
    expect(getServerDB).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });

  it('audits stale reauthentication denial before preparing any restart intent', async () => {
    const operator = await callerFor(ids.operator, new Date(Date.now() - 60 * 60 * 1000));
    await expect(
      operator.prepareRestart({
        reason: 'Activate the tested provider',
        requestId: '550e8400-e29b-41d4-a716-446655440056',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'ADMIN_REAUTH_REQUIRED' });
    expect(await db.select().from(platformIdentityProviderRestartRequests)).toHaveLength(0);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.system.prepareRestart',
        result: 'denied',
      }),
    );
  });
});

describe('admin.system operations gate', () => {
  it('allows a system reader and denies a user without platform_system:read:all', async () => {
    const operator = await callerFor(ids.operator);
    await expect(operator.getJobs()).resolves.toEqual({ items: [], nextCursor: null });

    const reader = await callerFor(ids.reader);
    await expect(reader.getJobs()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_PERMISSION_DENIED',
    });
  });

  it('lets a system reader load masked infra settings and denies a live probe', async () => {
    const operator = await callerFor(ids.operator);
    await expect(operator.getInfraSettings()).resolves.toMatchObject({
      mail: { provider: expect.any(String) },
      objectStorage: { pathStyle: expect.any(Boolean) },
    });

    const reader = await callerFor(ids.reader);
    await expect(reader.getInfraSettings()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_PERMISSION_DENIED',
    });
    await expect(reader.testDependency({ dependency: 'mail' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_PERMISSION_DENIED',
    });
  });

  it('runs a non-persisting probe without a reason or reauth session', async () => {
    const operator = await callerFor(ids.operator, new Date(Date.now() - 60 * 60 * 1000));
    const result = await operator.testDependency({ dependency: 'mail' });
    expect(result).toEqual(
      expect.objectContaining({
        checkedAt: expect.any(Date),
        latencyMs: expect.any(Number),
        ok: expect.any(Boolean),
      }),
    );
    expect(await db.select().from(platformAuditLogs)).toHaveLength(0);
  });

  it('denies job mutation before touching state when system operate permission is absent', async () => {
    await db.insert(platformJobs).values({
      id: 'pjob_0000000000000099',
      idempotencyKey: 'router-system-denied',
      status: 'pending',
      type: 'connector.runtime.shared-call.v1',
    });
    const reader = await callerFor(ids.reader);
    await expect(
      reader.cancelJob({
        expectedRevision: 0,
        expectedStatus: 'pending',
        jobId: 'pjob_0000000000000099',
        reason: 'permission denied test',
        requestId: '550e8400-e29b-41d4-a716-446655440061',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PLATFORM_PERMISSION_DENIED' });
    const [job] = await db
      .select({ status: platformJobs.status })
      .from(platformJobs)
      .where(eq(platformJobs.id, 'pjob_0000000000000099'));
    expect(job?.status).toBe('pending');
  });

  it('rejects enabling object storage without a stored secret', async () => {
    const operator = await callerFor(ids.operator);
    await expect(
      operator.updateInfraSettings({
        config: {
          accessKeyId: 'AKIAEXAMPLEKEY',
          bucket: 'files',
          enabled: true,
          endpoint: 'https://s3.example.com',
          forcePathStyle: false,
          secretAccessKey: { action: 'keep' },
          setAcl: false,
        },
        dependency: 'objectStorage',
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/secretAccessKey required|PLATFORM_INVALID_INPUT/),
    });
  });

  it('persists object storage via CAS and redacts the audit afterDiff', async () => {
    vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubEnv('PLATFORM_KEY_PROVIDER', 'env');
    const operator = await callerFor(ids.operator);
    const result = await operator.updateInfraSettings({
      config: {
        accessKeyId: 'AKIAEXAMPLEKEY',
        bucket: 'files',
        enabled: true,
        endpoint: 'https://s3.example.com',
        forcePathStyle: false,
        secretAccessKey: { action: 'replace', value: 'super-secret-key' },
        setAcl: false,
      },
      dependency: 'objectStorage',
      expectedRevision: 0,
    });
    expect(result).toMatchObject({ revision: 1, source: 'db' });
    expect(result.appliedAt).toBeInstanceOf(Date);

    const logs = await db.select().from(platformAuditLogs);
    expect(logs).toContainEqual(
      expect.objectContaining({
        action: 'system.infra.object_storage.update',
        result: 'success',
        targetType: 'infra_settings',
      }),
    );
    expect(JSON.stringify(logs)).not.toContain('super-secret-key');
  });

  it('rejects keep when the object-storage destination tuple changes', async () => {
    vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubEnv('PLATFORM_KEY_PROVIDER', 'env');
    const operator = await callerFor(ids.operator);
    await operator.updateInfraSettings({
      config: {
        accessKeyId: 'AKIAEXAMPLEKEY',
        bucket: 'files',
        enabled: true,
        endpoint: 'https://s3.example.com',
        forcePathStyle: false,
        secretAccessKey: { action: 'replace', value: 'super-secret-key' },
        setAcl: false,
      },
      dependency: 'objectStorage',
      expectedRevision: 0,
    });

    await expect(
      operator.updateInfraSettings({
        config: {
          accessKeyId: 'AKIAEXAMPLEKEY',
          bucket: 'files',
          enabled: true,
          endpoint: 'https://attacker.example',
          forcePathStyle: false,
          secretAccessKey: { action: 'keep' },
          setAcl: false,
        },
        dependency: 'objectStorage',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /re-entered after changing the destination|PLATFORM_INVALID_INPUT/,
      ),
    });
  });

  it('disables object storage with a minimal payload and keeps stored non-secret fields', async () => {
    await db.insert(platformInfraSettings).values({
      config: {
        accessKeyId: 'AKIASTOREDKEY',
        bucket: 'kept-bucket',
        enabled: true,
        endpoint: 'https://s3.example.com',
        forcePathStyle: true,
        region: 'us-west-2',
        secretAccessKeyCiphertext: 'garbage-undecryptable-ciphertext',
        setAcl: true,
      },
      id: 'object_storage',
      revision: 0,
    });
    const operator = await callerFor(ids.operator);
    const result = await operator.updateInfraSettings({
      config: { enabled: false },
      dependency: 'objectStorage',
      expectedRevision: 0,
    });
    expect(result).toMatchObject({ source: 'env' });
    const [row] = await db
      .select()
      .from(platformInfraSettings)
      .where(eq(platformInfraSettings.id, 'object_storage'));
    expect(row?.config).toMatchObject({
      accessKeyId: 'AKIASTOREDKEY',
      bucket: 'kept-bucket',
      enabled: false,
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      region: 'us-west-2',
      secretAccessKeyCiphertext: 'garbage-undecryptable-ciphertext',
      setAcl: true,
    });
  });

  it('disables object storage even when the stored ciphertext cannot be decrypted', async () => {
    vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 3).toString('base64'));
    vi.stubEnv('PLATFORM_KEY_PROVIDER', 'env');
    await db.insert(platformInfraSettings).values({
      config: {
        accessKeyId: 'AKIASTOREDKEY',
        bucket: 'kept-bucket',
        enabled: true,
        endpoint: 'https://s3.example.com',
        forcePathStyle: false,
        secretAccessKeyCiphertext: 'not-a-valid-sealed-secret',
        setAcl: false,
      },
      id: 'object_storage',
      revision: 0,
    });
    const operator = await callerFor(ids.operator);
    await expect(
      operator.updateInfraSettings({
        config: { enabled: false },
        dependency: 'objectStorage',
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({ source: 'env' });
  });

  it('requires recent reauth for updateInfraSettings', async () => {
    const operator = await callerFor(ids.operator, new Date(Date.now() - 60 * 60 * 1000));
    await expect(
      operator.updateInfraSettings({
        config: {
          accessKeyId: 'AKIAEXAMPLEKEY',
          bucket: 'files',
          enabled: false,
          endpoint: 'https://s3.example.com',
          forcePathStyle: false,
          secretAccessKey: { action: 'keep' },
          setAcl: false,
        },
        dependency: 'objectStorage',
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'ADMIN_REAUTH_REQUIRED' });
  });
});
