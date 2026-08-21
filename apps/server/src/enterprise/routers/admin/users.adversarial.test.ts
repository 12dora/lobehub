/**
 * Adversarial + permission-matrix tests for admin.users (M04).
 *
 * @vitest-environment node
 */
import { WORKSPACE_SYSTEM_ROLES } from '@lobechat/const/rbac';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  rolePermissions,
  roles,
  session,
  userRoles,
  users,
  workspaces,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { seedWorkspaceRoles } from '@/database/utils/seedWorkspaceRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { ADMIN_REAUTH_MAX_AGE_MS } from '../../contracts/adminUsers';
import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import {
  InMemoryPlatformConfigInvalidationPublisher,
  setPlatformConfigInvalidationPublisher,
} from '../../services/platformConfigInvalidation';
import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { liveActorSessionIdFor, seedLiveActorSession } from '../../testing/seedLiveActorSession';
import { adminRouter } from '../admin';

let db: LobeChatDatabase;
const invalidation = new InMemoryPlatformConfigInvalidationPublisher();

const deleteBetterAuthSecondaryStorageSessions = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('../../services/adminUser/betterAuthSecondaryStorage', () => ({
  deleteBetterAuthSecondaryStorageSessions,
}));

vi.mock('@/libs/oidc-provider/access-control', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    revokeOIDCArtifactsByUserId: vi.fn(async () => undefined),
  };
});

const createAdminCaller = createCallerFactory(adminRouter);

const IDS = {
  aiAdmin: 'm04-ai-admin',
  auditor: 'm04-auditor',
  identityAdmin: 'm04-identity-admin',
  normal: 'm04-normal',
  superAdmin: 'm04-super-admin',
  superAdmin2: 'm04-super-admin-2',
  target: 'm04-target-user',
  userAdmin: 'm04-user-admin',
  workspaceOwner: 'm04-ws-owner',
};

const workspaceId = 'm04-ws';

const cleanup = async () => {
  await db.delete(session);
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(IDS) });
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(workspaces);
  await db.delete(users);
};

const grantGlobalRole = async (userId: string, roleName: string) => {
  const role = await db.query.roles.findFirst({
    where: (t, { and: a, eq: e, isNull: n }) => a(e(t.name, roleName), n(t.workspaceId)),
  });
  if (!role) throw new Error(`role ${roleName} missing`);
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeAll(async () => {
  db = await getTestDB();
}, 120_000);

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  invalidation.events.length = 0;
  setPlatformConfigInvalidationPublisher(invalidation);
  await cleanup();
  await db.insert(users).values(
    Object.values(IDS).map((id) => ({
      email: `${id}@example.com`,
      id,
      normalizedEmail: `${id}@example.com`,
      username: id,
    })),
  );
  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'M04 WS',
    primaryOwnerId: IDS.workspaceOwner,
    slug: 'm04-ws',
  });
  await seedWorkspaceRoles(db, workspaceId);
  await seedPlatformRoles(db);

  await grantGlobalRole(IDS.superAdmin, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  await grantGlobalRole(IDS.superAdmin2, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  await grantGlobalRole(IDS.userAdmin, PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  await grantGlobalRole(IDS.aiAdmin, PLATFORM_SYSTEM_ROLES.AI_ADMIN);
  await grantGlobalRole(IDS.identityAdmin, PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN);
  await grantGlobalRole(IDS.auditor, PLATFORM_SYSTEM_ROLES.AUDITOR);
  await grantGlobalRole(IDS.normal, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
  await grantGlobalRole(IDS.workspaceOwner, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
  await grantGlobalRole(IDS.target, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);

  const { RbacModel } = await import('@/database/models/rbac');
  const rbac = new RbacModel(db, IDS.workspaceOwner);
  await rbac.assignWorkspaceRole({
    roleName: WORKSPACE_SYSTEM_ROLES.OWNER,
    userId: IDS.workspaceOwner,
    workspaceId,
  });
});

afterEach(async () => {
  await cleanup();
  setPlatformConfigInvalidationPublisher(null);
  vi.unstubAllEnvs();
});

const withDbCtx = async (
  userId?: string,
  extras?: {
    authenticatedAt?: Date | null;
    authMethod?: 'better-auth' | 'oidc' | 'api-key' | 'dev-mock' | null;
    sessionId?: string | null;
  },
) => {
  const now = new Date();
  const authMethod = extras?.authMethod ?? 'better-auth';
  const sessionId =
    extras && 'sessionId' in extras
      ? extras.sessionId
      : userId
        ? liveActorSessionIdFor(userId)
        : null;
  if (
    userId &&
    authMethod === 'better-auth' &&
    typeof sessionId === 'string' &&
    sessionId.length > 0
  ) {
    await seedLiveActorSession(db, { now, sessionId, userId });
  }
  const base = await createContextInner(
    userId
      ? {
          authenticatedAt: extras && 'authenticatedAt' in extras ? extras.authenticatedAt : now,
          authMethod,
          sessionId,
          userId,
        }
      : {},
  );
  return { ...base, serverDB: db } as never;
};

const expectEnterpriseCode = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise;
    expect.fail(`expected enterprise error ${code}`);
  } catch (error) {
    const body = getEnterpriseErrorBody(error);
    expect(body?.code).toBe(code);
  }
};

describe('admin.users permission matrix', () => {
  const writeCases = [
    {
      method: 'ban' as const,
      call: (c: ReturnType<typeof createAdminCaller>) =>
        c.users.ban({ reason: 'r', userId: IDS.target }),
    },
    {
      method: 'unban' as const,
      call: (c: ReturnType<typeof createAdminCaller>) =>
        c.users.unban({ reason: 'r', userId: IDS.target }),
    },
    {
      method: 'revokeSessions' as const,
      call: (c: ReturnType<typeof createAdminCaller>) =>
        c.users.revokeSessions({ reason: 'r', userId: IDS.target }),
    },
    {
      method: 'replaceGlobalRoles' as const,
      call: (c: ReturnType<typeof createAdminCaller>) =>
        c.users.replaceGlobalRoles({
          reason: 'r',
          roleNames: [PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
          userId: IDS.target,
        }),
    },
  ];

  it('anonymous is unauthorized on list', async () => {
    const caller = createAdminCaller(await withDbCtx());
    await expect(caller.users.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  for (const [label, userId] of [
    ['normal', IDS.normal],
    ['workspace_owner', IDS.workspaceOwner],
  ] as const) {
    it(`${label} cannot list users`, async () => {
      const caller = createAdminCaller(await withDbCtx(userId));
      await expectEnterpriseCode(
        caller.users.list({}),
        PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      );
    });

    for (const w of writeCases) {
      it(`${label} cannot ${w.method}`, async () => {
        const caller = createAdminCaller(await withDbCtx(userId));
        await expectEnterpriseCode(w.call(caller), PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED);
      });
    }
  }

  it('ai_admin can list (USER_READ) but cannot ban', async () => {
    const caller = createAdminCaller(await withDbCtx(IDS.aiAdmin));
    await expect(caller.users.list({ limit: 5 })).resolves.toMatchObject({
      items: expect.any(Array),
    });
    await expectEnterpriseCode(
      caller.users.ban({ reason: 'nope', userId: IDS.target }),
      PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
    );
  });

  it('auditor can list and getAuditTrail but cannot ban', async () => {
    const caller = createAdminCaller(await withDbCtx(IDS.auditor));
    await expect(caller.users.list({ limit: 5 })).resolves.toBeTruthy();
    await expect(caller.users.getAuditTrail({ userId: IDS.target })).resolves.toBeTruthy();
    await expectEnterpriseCode(
      caller.users.ban({ reason: 'nope', userId: IDS.target }),
      PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
    );
  });

  it('user_admin can list/get/ban and cannot manage super_admin roles', async () => {
    const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
    const listed = await caller.users.list({ limit: 20 });
    expect(listed.items.some((i) => i.id === IDS.target)).toBe(true);

    const detail = await caller.users.get({ userId: IDS.target });
    expect(detail.id).toBe(IDS.target);
    const detailJson = JSON.stringify(detail);
    expect(detailJson).not.toMatch(/accessToken|refreshToken/i);
    expect(detailJson).not.toMatch(/"password"\s*:/);

    await expect(caller.users.ban({ reason: 'abuse', userId: IDS.target })).resolves.toMatchObject({
      banned: true,
    });

    await expectEnterpriseCode(
      caller.users.replaceGlobalRoles({
        reason: 'try super',
        roleNames: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
        userId: IDS.target,
      }),
      PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
    );

    // Demote existing super_admin also denied for user_admin
    await expectEnterpriseCode(
      caller.users.replaceGlobalRoles({
        reason: 'try demote',
        roleNames: [PLATFORM_SYSTEM_ROLES.USER_ADMIN],
        userId: IDS.superAdmin,
      }),
      PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
    );
  });

  it('super_admin can replace roles including super_admin on others', async () => {
    const caller = createAdminCaller(await withDbCtx(IDS.superAdmin));
    await expect(
      caller.users.replaceGlobalRoles({
        reason: 'promote',
        roleNames: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN, PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
        userId: IDS.target,
      }),
    ).resolves.toMatchObject({
      roleNames: expect.arrayContaining([PLATFORM_SYSTEM_ROLES.SUPER_ADMIN]),
    });
  });
});

describe('admin.users reauth', () => {
  it('stale authenticatedAt is denied with ADMIN_REAUTH_REQUIRED', async () => {
    const caller = createAdminCaller(
      await withDbCtx(IDS.userAdmin, {
        // Derived from the window, not a literal: the window has been widened once
        // and a literal silently stops exercising staleness when it is.
        authenticatedAt: new Date(Date.now() - ADMIN_REAUTH_MAX_AGE_MS - 1000),
        authMethod: 'better-auth',
      }),
    );
    await expectEnterpriseCode(
      caller.users.ban({ reason: 'stale', userId: IDS.target }),
      ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
    );
  });

  it('missing authenticatedAt is denied', async () => {
    const caller = createAdminCaller(
      await withDbCtx(IDS.userAdmin, {
        authenticatedAt: null,
        authMethod: 'better-auth',
      }),
    );
    await expectEnterpriseCode(
      caller.users.revokeSessions({ reason: 'no-auth-time', userId: IDS.target }),
      ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
    );
  });

  it('api-key auth cannot satisfy reauth', async () => {
    const caller = createAdminCaller(
      await withDbCtx(IDS.userAdmin, {
        authenticatedAt: new Date(),
        authMethod: 'api-key',
      }),
    );
    await expectEnterpriseCode(
      caller.users.unban({ reason: 'api', userId: IDS.target }),
      ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
    );
  });
});

describe('admin.users ban / sessions / roles', () => {
  it('rejects self-ban', async () => {
    const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
    await expectEnterpriseCode(
      caller.users.ban({ reason: 'self', userId: IDS.userAdmin }),
      PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
    );
  });

  it('last super admin cannot be banned', async () => {
    // remove second super
    await db.delete(userRoles).where(eq(userRoles.userId, IDS.superAdmin2));

    const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
    // user_admin can ban non-super; for super, last-super after permission...
    // user_admin CAN ban super_admin users (ban is USER_BAN, not role manage) —
    // last-super protection must still apply.
    await expectEnterpriseCode(
      caller.users.ban({ reason: 'last', userId: IDS.superAdmin }),
      PLATFORM_ERROR_CODES.PLATFORM_LAST_SUPER_ADMIN,
    );
  });

  it('banning one of two supers succeeds and revokes their sessions', async () => {
    await db.insert(session).values({
      expiresAt: new Date(Date.now() + 3600_000),
      id: 's-super',
      token: 'tok-super',
      updatedAt: new Date(),
      userId: IDS.superAdmin,
    });
    await db.insert(session).values({
      expiresAt: new Date(Date.now() + 3600_000),
      id: 's-target',
      token: 'tok-target',
      updatedAt: new Date(),
      userId: IDS.target,
    });

    const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
    await caller.users.ban({ reason: 'two supers', userId: IDS.superAdmin });

    const banned = await db.query.users.findFirst({ where: eq(users.id, IDS.superAdmin) });
    expect(banned?.banned).toBe(true);

    const superSessions = await db.query.session.findMany({
      where: eq(session.userId, IDS.superAdmin),
    });
    expect(superSessions).toHaveLength(0);

    const otherSessions = await db.query.session.findMany({
      where: eq(session.userId, IDS.target),
    });
    expect(otherSessions).toHaveLength(1);

    const audits = await db.query.platformAuditLogs.findMany({
      where: and(
        eq(platformAuditLogs.action, 'admin.users.ban'),
        eq(platformAuditLogs.targetId, IDS.superAdmin),
      ),
    });
    expect(audits.some((a) => a.result === 'success' && a.reason === 'two supers')).toBe(true);
  });

  it('revoking target sessions does not affect another user', async () => {
    await db.insert(session).values([
      {
        expiresAt: new Date(Date.now() + 3600_000),
        id: 's-t1',
        token: 't1',
        updatedAt: new Date(),
        userId: IDS.target,
      },
      {
        expiresAt: new Date(Date.now() + 3600_000),
        id: 's-n1',
        token: 'n1',
        updatedAt: new Date(),
        userId: IDS.normal,
      },
    ]);

    const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
    const result = await caller.users.revokeSessions({
      reason: 'compromise',
      userId: IDS.target,
    });
    expect(result.revokedCount).toBe(1);

    expect(await db.query.session.findMany({ where: eq(session.userId, IDS.target) })).toHaveLength(
      0,
    );
    expect(await db.query.session.findMany({ where: eq(session.userId, IDS.normal) })).toHaveLength(
      1,
    );

    expect(invalidation.events.some((e) => e.resourceId === IDS.target)).toBe(true);
  });

  it('replaceGlobalRoles preserves workspace roles', async () => {
    const { RbacModel } = await import('@/database/models/rbac');
    const rbac = new RbacModel(db, IDS.target);
    await rbac.assignWorkspaceRole({
      roleName: WORKSPACE_SYSTEM_ROLES.MEMBER,
      userId: IDS.target,
      workspaceId,
    });

    const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
    await caller.users.replaceGlobalRoles({
      reason: 'swap package',
      roleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
      userId: IDS.target,
    });

    const global = await db.query.userRoles.findMany({
      where: and(eq(userRoles.userId, IDS.target), isNull(userRoles.workspaceId)),
    });
    const ws = await db.query.userRoles.findMany({
      where: and(eq(userRoles.userId, IDS.target), eq(userRoles.workspaceId, workspaceId)),
    });
    expect(ws.length).toBeGreaterThan(0);
    expect(global.length).toBeGreaterThan(0);

    const detail = await caller.users.get({ userId: IDS.target });
    expect(detail.roles.some((r) => r.name === PLATFORM_SYSTEM_ROLES.AUDITOR)).toBe(true);
  });

  it('replaceGlobalRoles with expiresAt writes real expiry', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
    await caller.users.replaceGlobalRoles({
      expiresAt,
      reason: 'temp auditor',
      roleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
      userId: IDS.target,
    });

    const grants = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, IDS.target), isNull(userRoles.workspaceId)));
    expect(
      grants.some(
        (g) => g.expiresAt && Math.abs(g.expiresAt.getTime() - expiresAt.getTime()) < 1000,
      ),
    ).toBe(true);
  });

  it('cannot replace roles on self (covers last-super self-demotion)', async () => {
    await db.delete(userRoles).where(eq(userRoles.userId, IDS.superAdmin2));
    const caller = createAdminCaller(await withDbCtx(IDS.superAdmin));
    await expect(
      caller.users.replaceGlobalRoles({
        reason: 'demote self last',
        roleNames: [PLATFORM_SYSTEM_ROLES.USER_ADMIN],
        userId: IDS.superAdmin,
      }),
    ).rejects.toMatchObject({
      cause: { data: { code: 'PLATFORM_INVALID_INPUT', details: { reason: 'self_role_change' } } },
    });
  });

  it('list does not log full query and returns safe projections', async () => {
    const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
    const result = await caller.users.list({ query: 'm04-target', limit: 10 });
    for (const item of result.items) {
      expect(item).not.toHaveProperty('password');
      expect(item).not.toHaveProperty('token');
    }
  });

  it('getAuditTrail is bounded and redacted', async () => {
    const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
    await caller.users.ban({ reason: 'trail', userId: IDS.target });
    const trail = await caller.users.getAuditTrail({ userId: IDS.target, limit: 10 });
    expect(trail.items.some((i) => i.action === 'admin.users.ban')).toBe(true);
    expect(JSON.stringify(trail)).not.toMatch(/access_token|password|SESSION_TOKEN/i);
  });
});

describe('admin.users feature flag off', () => {
  it('returns ADMIN_FEATURE_DISABLED', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    const caller = createAdminCaller(await withDbCtx(IDS.superAdmin));
    await expectEnterpriseCode(caller.users.list({}), ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED);
  });
});
