/**
 * M04 R1 rework regression tests (blockers + majors).
 * @vitest-environment node
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { permissions, rolePermissions, roles, session, userRoles, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { adminUsersGetOutputSchema, adminUsersListOutputSchema } from '../../contracts/adminUsers';
import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { adminRouter } from '../admin';

let db: LobeChatDatabase;

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
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
  super: 'r1-super',
  super2: 'r1-super-2',
  target: 'r1-target',
  userAdmin: 'r1-user-admin',
};

const cleanup = async () => {
  await db.delete(session);
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(IDS) });
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

const grant = async (userId: string, roleName: string) => {
  const role = await db.query.roles.findFirst({
    where: (t, { and, eq, isNull }) => and(eq(t.name, roleName), isNull(t.workspaceId)),
  });
  if (!role) throw new Error(roleName);
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeAll(async () => {
  db = await getTestDB();
}, 120_000);

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
  await db.insert(users).values(Object.values(IDS).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await grant(IDS.super, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  await grant(IDS.super2, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  await grant(IDS.userAdmin, PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  await grant(IDS.target, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const ctx = async (
  userId: string,
  extras?: { authenticatedAt?: Date | null; authMethod?: any },
) => {
  const base = await createContextInner({
    authenticatedAt: extras && 'authenticatedAt' in extras ? extras.authenticatedAt : new Date(),
    authMethod: extras?.authMethod ?? 'better-auth',
    sessionId: 'actor-sess',
    userId,
  });
  return { ...base, serverDB: db } as never;
};

describe('M04 R1 — super_admin permanent', () => {
  it('rejects expiresAt with super_admin via admin.users', async () => {
    const caller = createAdminCaller(await ctx(IDS.super));
    await expect(
      caller.users.replaceGlobalRoles({
        expiresAt: new Date(Date.now() + 86_400_000),
        reason: 'temp super',
        roleNames: [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN],
        userId: IDS.target,
      }),
    ).rejects.toBeTruthy();
  });

  it('admin.roles.replaceUserGlobalRoles requires reauth', async () => {
    const caller = createAdminCaller(
      await ctx(IDS.super, { authenticatedAt: null, authMethod: 'better-auth' }),
    );
    try {
      await caller.roles.replaceUserGlobalRoles({
        reason: 'no reauth',
        roleNames: [PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
        userId: IDS.target,
      });
      expect.fail('expected reauth error');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
    }
  });
});

describe('M04 R1 — authInvalidatedAt + ban', () => {
  it('ban sets authInvalidatedAt and revokes sessions', async () => {
    await db.insert(session).values({
      expiresAt: new Date(Date.now() + 3600_000),
      id: 'r1-sess',
      token: 'tok',
      updatedAt: new Date(),
      userId: IDS.target,
    });
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    await caller.users.ban({ reason: 'x', userId: IDS.target });
    const u = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, IDS.target) });
    expect(u?.banned).toBe(true);
    expect(u?.authInvalidatedAt).toBeTruthy();
    const sessions = await db.query.session.findMany({
      where: (t, { eq }) => eq(t.userId, IDS.target),
    });
    expect(sessions).toHaveLength(0);
  });

  it('expired temporary ban is treated as active in list', async () => {
    const { eq } = await import('drizzle-orm');
    await db
      .update(users)
      .set({ banExpires: new Date(Date.now() - 1000), banned: true })
      .where(eq(users.id, IDS.target));

    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    const banned = await caller.users.list({ status: 'banned' });
    expect(banned.items.some((i) => i.id === IDS.target)).toBe(false);
    const active = await caller.users.list({ status: 'active' });
    expect(active.items.some((i) => i.id === IDS.target)).toBe(true);
  });
});

describe('M04 R1 — output schemas reject secrets', () => {
  it('list/get output schemas are strict against password/token fields', () => {
    expect(() =>
      adminUsersListOutputSchema.parse({
        items: [
          {
            avatar: null,
            createdAt: new Date(),
            email: null,
            fullName: null,
            id: 'x',
            lastActiveAt: null,
            password: 'secret',
            providerIds: [],
            roles: [],
            status: 'active',
            username: null,
          },
        ],
        nextCursor: null,
      }),
    ).toThrow();

    expect(() =>
      adminUsersGetOutputSchema.parse({
        avatar: null,
        banExpires: null,
        banReason: null,
        banned: false,
        createdAt: new Date(),
        email: null,
        fullName: null,
        id: 'x',
        isSelf: false,
        lastActiveAt: null,
        password: 'x',
        providers: [],
        roles: [],
        sessionCount: 0,
        sessions: [],
        status: 'active',
        accessToken: 'tok',
        username: null,
      }),
    ).toThrow();
  });
});

describe('M04 list identity search', () => {
  it('matches fullName prefix case-insensitively', async () => {
    const { eq } = await import('drizzle-orm');
    await db.update(users).set({ fullName: 'Zelda Target' }).where(eq(users.id, IDS.target));
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    const result = await caller.users.list({ limit: 10, query: 'ZELDA' });
    expect(result.items.some((item) => item.id === IDS.target)).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });
});

describe('M04 R1 — audit on list and reauth denial', () => {
  it('list writes access audit without full query', async () => {
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    await caller.users.list({ query: 'secret-search-term', limit: 5 });
    const rows = await db.query.platformAuditLogs.findMany({
      where: (t, { eq }) => eq(t.action, 'admin.users.list'),
    });
    expect(rows.length).toBeGreaterThan(0);
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain('secret-search-term');
    expect(blob).toMatch(/queryFingerprint|hasQuery/);
  });

  it('stale reauth writes denied audit', async () => {
    const caller = createAdminCaller(
      await ctx(IDS.userAdmin, {
        authenticatedAt: new Date(Date.now() - 3600_000),
      }),
    );
    await expect(caller.users.ban({ reason: 'stale', userId: IDS.target })).rejects.toBeTruthy();
    const rows = await db.query.platformAuditLogs.findMany({
      where: (t, { eq }) => eq(t.action, 'admin.users.ban'),
    });
    expect(rows.some((r) => r.result === 'denied')).toBe(true);
  });
});

describe('M04 R1 — banned direct caller blocked by withActiveUser', () => {
  it('banned userAdmin cannot list even with createContextInner', async () => {
    const { eq } = await import('drizzle-orm');
    await db.update(users).set({ banned: true }).where(eq(users.id, IDS.userAdmin));
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    try {
      await caller.users.list({});
      expect.fail('expected deny');
    } catch (error) {
      const body = getEnterpriseErrorBody(error);
      expect(
        body?.code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED ||
          (error as { code?: string }).code === 'UNAUTHORIZED',
      ).toBe(true);
    }
  });
});

describe('M04 R1 — identity_admin matrix', () => {
  it('identity_admin can list/get but cannot ban or replace roles', async () => {
    const id = 'r1-identity-admin';
    await db.insert(users).values({ id });
    await grant(id, PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN);
    const caller = createAdminCaller(await ctx(id));
    await expect(caller.users.list({ limit: 5 })).resolves.toBeTruthy();
    await expect(caller.users.get({ userId: IDS.target })).resolves.toMatchObject({
      id: IDS.target,
    });
    try {
      await caller.users.ban({ reason: 'nope', userId: IDS.target });
      expect.fail('expected deny');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      );
    }
    try {
      await caller.users.replaceGlobalRoles({
        reason: 'nope',
        roleNames: [PLATFORM_SYSTEM_ROLES.PLATFORM_USER],
        userId: IDS.target,
      });
      expect.fail('expected deny');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      );
    }
  });
});

describe('M04 R1 — replaceGlobalRoles audit atomicity', () => {
  it('success writes platform.roles.replace + admin.users.replaceGlobalRoles', async () => {
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    await caller.users.replaceGlobalRoles({
      reason: 'atomic roles',
      roleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
      userId: IDS.target,
    });
    const rows = await db.query.platformAuditLogs.findMany({
      where: (t, { eq }) => eq(t.targetId, IDS.target),
    });
    expect(rows.some((r) => r.action === 'platform.roles.replace' && r.result === 'success')).toBe(
      true,
    );
    expect(
      rows.some((r) => r.action === 'admin.users.replaceGlobalRoles' && r.result === 'success'),
    ).toBe(true);
  });

  it('blocks replacing roles on self with a denied audit', async () => {
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    await expect(
      caller.users.replaceGlobalRoles({
        reason: 'self',
        roleNames: [PLATFORM_SYSTEM_ROLES.USER_ADMIN],
        userId: IDS.userAdmin,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { data: { code: 'PLATFORM_INVALID_INPUT', details: { reason: 'self_role_change' } } },
    });
    const denied = (
      await db.query.platformAuditLogs.findMany({
        where: (t, { eq }) => eq(t.action, 'admin.users.replaceGlobalRoles'),
      })
    ).filter((a) => a.result === 'denied' && a.targetId === IDS.userAdmin);
    expect(
      denied.some((a) => (a.afterDiff as { error?: string })?.error === 'self_role_change'),
    ).toBe(true);
  });
});
