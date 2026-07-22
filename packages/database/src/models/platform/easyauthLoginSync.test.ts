// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AIHUB_ACCESS_PERMISSION } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { getTestDB } from '../../core/getTestDB';
import { account } from '../../schemas/betterAuth';
import { platformEasyauthGrantSnapshots, platformJobs } from '../../schemas/platform';
import { permissions, rolePermissions, roles, userRoles } from '../../schemas/rbac';
import { users } from '../../schemas/user';
import type { LobeChatDatabase } from '../../type';
import { seedPlatformRoles } from '../../utils/seedPlatformRoles';
import { syncEasyauthOnLogin } from './easyauthLoginSync';

const db: LobeChatDatabase = await getTestDB();
const userId = 'easyauth-login-sync-user';

const cleanup = async () => {
  await db.delete(platformJobs);
  await db.delete(platformEasyauthGrantSnapshots);
  await db.delete(account);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

const grantRole = async (roleName: string) => {
  const role = await db.query.roles.findFirst({
    where: (t, { and, eq, isNull }) => and(eq(t.name, roleName), isNull(t.workspaceId)),
  });
  if (!role) throw new Error(roleName);
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

const listRoleNames = async () => {
  const rows = await db
    .select({ name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id));
  return rows.map((r) => r.name).sort();
};

const fetchMock = vi.fn();

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values({ id: userId });
  await seedPlatformRoles(db);

  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('EASYAUTH_APP_TOKEN', 'eat_fake_test_token_not_real');
  vi.stubEnv('EASYAUTH_BASE_URL', 'https://easyauth.test');

  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await cleanup();
});

describe('syncEasyauthOnLogin', () => {
  it('skips credential-only users without calling EasyAuth and preserves snapshot + roles', async () => {
    // Admin-created credential user: local account (accountId = local user id),
    // admin-create snapshot, platform_user role.
    await db.insert(account).values({
      accountId: userId,
      id: 'acct-login-cred',
      password: 'scrypt-hash-placeholder',
      providerId: 'credential',
      userId,
    });
    await db.insert(platformEasyauthGrantSnapshots).values({
      accessGranted: true,
      appKey: 'aihub',
      externalUserId: userId,
      grants: [{ permission: AIHUB_ACCESS_PERMISSION }],
      grantVersion: 1,
      snapshotVersion: 'admin-create',
      userId,
    });
    await grantRole(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);

    await syncEasyauthOnLogin(db, userId);

    // No EasyAuth lookup with the local id; snapshot and roles are untouched.
    expect(fetchMock).not.toHaveBeenCalled();
    const snapshots = await db.select().from(platformEasyauthGrantSnapshots);
    expect(snapshots).toMatchObject([
      { accessGranted: true, snapshotVersion: 'admin-create', userId },
    ]);
    expect(await listRoleNames()).toEqual([PLATFORM_SYSTEM_ROLES.PLATFORM_USER]);
  });

  it('resolves the external id from a linked authentik account, ignoring the credential row', async () => {
    await db.insert(account).values([
      {
        accountId: userId,
        id: 'acct-login-cred-2',
        password: 'scrypt-hash-placeholder',
        providerId: 'credential',
        userId,
      },
      {
        accountId: 'ak_uid_login_1',
        id: 'acct-login-ak',
        providerId: 'authentik',
        userId,
      },
    ]);

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          catalog_version: 1,
          grant_version: 2,
          grants: [{ permission: AIHUB_ACCESS_PERMISSION }],
          groups: [],
          snapshot_version: 'sv-login-1',
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );

    await syncEasyauthOnLogin(db, userId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0]![0]);
    expect(requestedUrl).toContain('/users/ak_uid_login_1/permissions');
    expect(requestedUrl).not.toContain(userId);

    const snapshots = await db.select().from(platformEasyauthGrantSnapshots);
    expect(snapshots).toMatchObject([
      { accessGranted: true, externalUserId: 'ak_uid_login_1', userId },
    ]);
    expect(await listRoleNames()).toEqual([PLATFORM_SYSTEM_ROLES.PLATFORM_USER]);
  });
});
