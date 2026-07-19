// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { getServerDB } from '@/database/core/db-adaptor';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(adminRouter);
const ids = { reader: 'm11-idp-reader', updater: 'm11-idp-updater' };
const roleNames = ['m11_idp_reader', 'm11_idp_updater'];

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await db.delete(platformIdentityProviderTestAttempts);
  await db.delete(platformIdentityProviderSecrets);
  await db.delete(platformIdentityProviders);
  await db.delete(platformAuditLogs);
  const ownedRoles = await db
    .select({ id: roles.id })
    .from(roles)
    .where(inArray(roles.name, roleNames));
  if (ownedRoles.length > 0) {
    const roleIds = ownedRoles.map(({ id }) => id);
    await db.delete(userRoles).where(inArray(userRoles.roleId, roleIds));
    await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await db.delete(roles).where(inArray(roles.id, roleIds));
  }
  await db.delete(users).where(sql`${users.id} LIKE 'm11-idp-%'`);
};

const grant = async (userId: string, name: string, code: string) => {
  const [role] = await db.insert(roles).values({ displayName: name, name }).returning();
  const [permission] = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.code, code));
  await db.insert(rolePermissions).values({ permissionId: permission.id, roleId: role.id });
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('APP_URL', 'https://app.example.test');
  vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 51).toString('base64'));
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await grant(ids.reader, roleNames[0], PLATFORM_PERMISSIONS.IDENTITY_READ);
  await grant(ids.updater, roleNames[1], PLATFORM_PERMISSIONS.IDENTITY_UPDATE);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (userId: string) => {
  const context = await createContextInner({
    authenticatedAt: new Date(),
    authMethod: 'better-auth',
    sessionId: `session-${userId}`,
    userId,
  });
  return createCaller({ ...context, serverDB: db } as never).identityProviders;
};

describe('admin.identityProviders RBAC and feature gate', () => {
  it('keeps read and update permissions separate', async () => {
    const reader = await callerFor(ids.reader);
    await expect(reader.list({ limit: 10 })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(
      reader.update({
        autoProvision: true,
        buttonLabel: 'Sign in',
        claimMapping: {
          dingtalkTitle: [],
          dingtalkUserId: [],
          email: ['email'],
          name: ['name'],
          picture: [],
          subject: ['sub'],
        },
        clientId: 'client',
        displayName: 'Work',
        domainAllowlist: [],
        expectedRevision: 0,
        groupRoleMapping: {},
        icon: null,
        id: 'missing',
        issuer: 'https://login.example.test',
        providerKey: 'work',
        reason: 'try update',
        scopes: ['openid'],
        secret: { operation: 'keep' },
        type: 'generic_oidc',
        usePkce: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const updater = await callerFor(ids.updater);
    await expect(updater.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects at the feature gate before constructing the secret-dependent runtime', async () => {
    const reader = await callerFor(ids.reader);
    vi.stubEnv('ENABLE_DATABASE_OIDC', '0');
    vi.stubEnv('PLATFORM_MASTER_KEY', 'not-a-key');
    vi.mocked(getServerDB).mockClear();
    const select = vi.spyOn(db, 'select');
    const secretFactory = vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise');
    await expect(reader.list({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
    expect(getServerDB).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(secretFactory).not.toHaveBeenCalled();
    select.mockRestore();
    secretFactory.mockRestore();
  });
});
