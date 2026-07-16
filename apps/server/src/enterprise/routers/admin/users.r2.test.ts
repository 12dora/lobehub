/**
 * M04 R2 adversarial / full-chain regressions.
 * @vitest-environment node
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { isCredentialInvalidated } from '@/database/utils/userBan';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import {
  adminUsersBanOutputSchema,
  adminUsersGetAuditTrailOutputSchema,
  adminUsersGetOutputSchema,
  adminUsersListOutputSchema,
  adminUsersReplaceGlobalRolesOutputSchema,
  adminUsersRevokeSessionsOutputSchema,
  adminUsersUnbanOutputSchema,
} from '../../contracts/adminUsers';
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
  super: 'r2-super',
  target: 'r2-target',
  userAdmin: 'r2-user-admin',
};

const cleanup = async () => {
  await db.delete(session);
  await db.delete(platformAuditLogs);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

const grant = async (userId: string, roleName: string) => {
  const role = await db.query.roles.findFirst({
    where: (t, { and, eq: e, isNull }) => and(e(t.name, roleName), isNull(t.workspaceId)),
  });
  if (!role) throw new Error(roleName);
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeAll(async () => {
  db = await getTestDB();
});

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
  await db.insert(users).values(Object.values(IDS).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await grant(IDS.super, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  await grant(IDS.userAdmin, PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  await grant(IDS.target, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const ctx = async (
  userId: string,
  extras?: {
    authenticatedAt?: Date | null;
    authMethod?: 'better-auth' | 'oidc' | 'api-key' | 'dev-mock' | null;
    credentialIssuedAt?: Date | null;
    sessionId?: string | null;
  },
) => {
  const now = new Date();
  const base = await createContextInner({
    authenticatedAt: extras && 'authenticatedAt' in extras ? extras.authenticatedAt : now,
    authMethod: extras?.authMethod ?? 'better-auth',
    credentialIssuedAt: extras && 'credentialIssuedAt' in extras ? extras.credentialIssuedAt : now,
    sessionId: extras?.sessionId ?? 'actor-sess',
    userId,
  });
  return { ...base, serverDB: db } as never;
};

describe('R2-01 includeCurrent=false preserves rotated session past cutoff', () => {
  it('retains current session credential after revoke; other session fails cutoff', async () => {
    const oldIssued = new Date('2024-01-01T00:00:00.000Z');
    await db.insert(session).values([
      {
        createdAt: oldIssued,
        expiresAt: new Date(Date.now() + 3600_000),
        id: 'keep-sess',
        token: 'tok-keep',
        updatedAt: oldIssued,
        userId: IDS.userAdmin,
      },
      {
        createdAt: oldIssued,
        expiresAt: new Date(Date.now() + 3600_000),
        id: 'drop-sess',
        token: 'tok-drop',
        updatedAt: oldIssued,
        userId: IDS.userAdmin,
      },
      {
        createdAt: oldIssued,
        expiresAt: new Date(Date.now() + 3600_000),
        id: 'other-user-sess',
        token: 'tok-other',
        updatedAt: oldIssued,
        userId: IDS.target,
      },
    ]);

    const caller = createAdminCaller(await ctx(IDS.userAdmin, { sessionId: 'keep-sess' }));
    await caller.users.revokeSessions({
      includeCurrent: false,
      reason: 'compromise others',
      userId: IDS.userAdmin,
    });

    const u = await db.query.users.findFirst({ where: eq(users.id, IDS.userAdmin) });
    expect(u?.authInvalidatedAt).toBeTruthy();
    const cutoff = u!.authInvalidatedAt!;

    const kept = await db.query.session.findFirst({ where: eq(session.id, 'keep-sess') });
    expect(kept).toBeTruthy();
    expect(kept!.createdAt.getTime()).toBeGreaterThan(cutoff.getTime());
    // Passes cutoff
    expect(isCredentialInvalidated({ authInvalidatedAt: cutoff }, kept!.createdAt)).toBe(false);

    // Dropped session gone
    expect(
      await db.query.session.findFirst({ where: eq(session.id, 'drop-sess') }),
    ).toBeUndefined();

    // Target user sessions untouched by this revoke
    expect(
      await db.query.session.findFirst({ where: eq(session.id, 'other-user-sess') }),
    ).toBeTruthy();

    // Old OIDC/API-style credential before cutoff fails
    expect(isCredentialInvalidated({ authInvalidatedAt: cutoff }, oldIssued)).toBe(true);
    // New post-cutoff credential passes
    expect(
      isCredentialInvalidated({ authInvalidatedAt: cutoff }, new Date(cutoff.getTime() + 5000)),
    ).toBe(false);

    // Retained session can still hit admin API with rotated credentialIssuedAt
    const after = createAdminCaller(
      await ctx(IDS.userAdmin, {
        credentialIssuedAt: kept!.createdAt,
        sessionId: 'keep-sess',
      }),
    );
    await expect(after.users.list({ limit: 1 })).resolves.toBeTruthy();

    // Old credential issuedAt fails active-user gate
    const stale = createAdminCaller(
      await ctx(IDS.userAdmin, {
        credentialIssuedAt: oldIssued,
        sessionId: 'keep-sess',
      }),
    );
    await expect(stale.users.list({ limit: 1 })).rejects.toBeTruthy();
  });
});

describe('R2-02 credentialIssuedAt vs authenticatedAt', () => {
  it('activeUser uses credentialIssuedAt not authenticatedAt for cutoff', async () => {
    const cutoff = new Date();
    await db.update(users).set({ authInvalidatedAt: cutoff }).where(eq(users.id, IDS.userAdmin));

    // Fresh reauth (authenticatedAt) but old credentialIssuedAt → denied
    const staleCred = createAdminCaller(
      await ctx(IDS.userAdmin, {
        authenticatedAt: new Date(),
        credentialIssuedAt: new Date(cutoff.getTime() - 10_000),
      }),
    );
    await expect(staleCred.users.list({})).rejects.toBeTruthy();

    // Old auth_time (reauth stale) but post-cutoff credential → list allowed (reauth only on mutations)
    const freshCred = createAdminCaller(
      await ctx(IDS.userAdmin, {
        authenticatedAt: new Date(cutoff.getTime() - 3600_000),
        credentialIssuedAt: new Date(cutoff.getTime() + 1000),
      }),
    );
    await expect(freshCred.users.list({ limit: 1 })).resolves.toBeTruthy();
  });
});

describe('R2-03 failed audits persist outside mutation rollback', () => {
  it('ban not-found leaves failure audit and no ban mutation', async () => {
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    await expect(
      caller.users.ban({ reason: 'missing', userId: 'does-not-exist' }),
    ).rejects.toBeTruthy();

    const audits = await db.query.platformAuditLogs.findMany({
      where: eq(platformAuditLogs.action, 'admin.users.ban'),
    });
    expect(audits.some((a) => a.result === 'failure' && a.targetId === 'does-not-exist')).toBe(
      true,
    );
  });

  it('permission denial writes admin.permission.denied audit', async () => {
    const caller = createAdminCaller(await ctx(IDS.target));
    await expect(caller.users.list({})).rejects.toBeTruthy();
    const audits = await db.query.platformAuditLogs.findMany({
      where: eq(platformAuditLogs.action, 'admin.permission.denied'),
    });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toMatch(/password|token|secret/i);
  });

  it('get not-found writes failure audit', async () => {
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    await expect(caller.users.get({ userId: 'nope' })).rejects.toBeTruthy();
    const audits = await db.query.platformAuditLogs.findMany({
      where: eq(platformAuditLogs.action, 'admin.users.get'),
    });
    expect(audits.some((a) => a.result === 'failure')).toBe(true);
  });
});

describe('R2-04 strict recursive output schemas reject secret fields', () => {
  const secretRoot = { secret: 'leak' };

  it.each([
    ['list', adminUsersListOutputSchema, { items: [], nextCursor: null, ...secretRoot }],
    [
      'get',
      adminUsersGetOutputSchema,
      {
        avatar: null,
        banExpires: null,
        banReason: null,
        banned: false,
        createdAt: new Date(),
        email: null,
        fullName: null,
        id: 'x',
        lastActiveAt: null,
        providers: [],
        roles: [],
        sessionCount: 0,
        sessions: [],
        status: 'active',
        username: null,
        ...secretRoot,
      },
    ],
    [
      'ban',
      adminUsersBanOutputSchema,
      { banExpires: null, banned: true, userId: 'x', ...secretRoot },
    ],
    ['unban', adminUsersUnbanOutputSchema, { banned: false, userId: 'x', ...secretRoot }],
    [
      'revokeSessions',
      adminUsersRevokeSessionsOutputSchema,
      { revokedCount: 0, userId: 'x', ...secretRoot },
    ],
    [
      'replaceGlobalRoles',
      adminUsersReplaceGlobalRolesOutputSchema,
      { roleNames: [], userId: 'x', ...secretRoot },
    ],
    [
      'getAuditTrail',
      adminUsersGetAuditTrailOutputSchema,
      { items: [], nextCursor: null, ...secretRoot },
    ],
  ] as const)('%s rejects unexpected root secret', (_name, schema, payload) => {
    expect(() => schema.parse(payload)).toThrow(/secret|Unrecognized/i);
  });

  it('get rejects nested provider secret', () => {
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
        lastActiveAt: null,
        providers: [{ providerId: 'p', secret: 'x' } as never],
        roles: [],
        sessionCount: 0,
        sessions: [],
        status: 'active',
        username: null,
      }),
    ).toThrow();
  });
});
