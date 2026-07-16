/**
 * M04 R2 adversarial / full-chain regressions (+ session exception correction).
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

describe('session exception model (includeCurrent=false)', () => {
  it('preserves current session without rewriting createdAt; does not refresh reauth clock', async () => {
    const originalLogin = new Date('2024-01-01T00:00:00.000Z');
    await db.insert(session).values([
      {
        createdAt: originalLogin,
        expiresAt: new Date(Date.now() + 3600_000),
        id: 'keep-sess',
        token: 'tok-keep',
        updatedAt: originalLogin,
        userId: IDS.userAdmin,
      },
      {
        createdAt: originalLogin,
        expiresAt: new Date(Date.now() + 3600_000),
        id: 'drop-sess',
        token: 'tok-drop',
        updatedAt: originalLogin,
        userId: IDS.userAdmin,
      },
    ]);

    // Mutation requires recent reauth; use fresh authenticatedAt for the revoke call.
    const caller = createAdminCaller(
      await ctx(IDS.userAdmin, {
        authenticatedAt: new Date(),
        credentialIssuedAt: originalLogin,
        sessionId: 'keep-sess',
      }),
    );
    await caller.users.revokeSessions({
      includeCurrent: false,
      reason: 'revoke others',
      userId: IDS.userAdmin,
    });

    const u = await db.query.users.findFirst({ where: eq(users.id, IDS.userAdmin) });
    expect(u?.authInvalidatedAt).toBeTruthy();
    expect(u?.authInvalidatedExcludedSessionId).toBe('keep-sess');

    const kept = await db.query.session.findFirst({ where: eq(session.id, 'keep-sess') });
    expect(kept).toBeTruthy();
    // Must NOT rewrite login time
    expect(kept!.createdAt.getTime()).toBe(originalLogin.getTime());
    expect(
      await db.query.session.findFirst({ where: eq(session.id, 'drop-sess') }),
    ).toBeUndefined();

    // Exception: same old issuance + matching session id passes
    expect(
      isCredentialInvalidated(
        {
          authInvalidatedAt: u!.authInvalidatedAt,
          authInvalidatedExcludedSessionId: u!.authInvalidatedExcludedSessionId,
        },
        { credentialIssuedAt: originalLogin, sessionId: 'keep-sess' },
      ),
    ).toBe(false);

    // Same old issuance without matching session id fails
    expect(
      isCredentialInvalidated(
        {
          authInvalidatedAt: u!.authInvalidatedAt,
          authInvalidatedExcludedSessionId: u!.authInvalidatedExcludedSessionId,
        },
        { credentialIssuedAt: originalLogin, sessionId: 'other-sess' },
      ),
    ).toBe(true);

    // OIDC/API key cannot spoof exception (no sessionId)
    expect(
      isCredentialInvalidated(
        {
          authInvalidatedAt: u!.authInvalidatedAt,
          authInvalidatedExcludedSessionId: u!.authInvalidatedExcludedSessionId,
        },
        { credentialIssuedAt: originalLogin, sessionId: null },
      ),
    ).toBe(true);

    // Preserved session still works on admin path with original credential + sessionId
    const preserved = createAdminCaller(
      await ctx(IDS.userAdmin, {
        authenticatedAt: originalLogin, // reauth clock unchanged
        credentialIssuedAt: originalLogin,
        sessionId: 'keep-sess',
      }),
    );
    await expect(preserved.users.list({ limit: 1 })).resolves.toBeTruthy();

    // authenticatedAt remains original — high-risk mutation still needs recent reauth
    await expect(
      preserved.users.ban({ reason: 'stale reauth', userId: IDS.target }),
    ).rejects.toBeTruthy();

    // Wrong session id fails active-user
    const wrongSess = createAdminCaller(
      await ctx(IDS.userAdmin, {
        credentialIssuedAt: originalLogin,
        sessionId: 'not-kept',
      }),
    );
    await expect(wrongSess.users.list({ limit: 1 })).rejects.toBeTruthy();
  });

  it('ban clears session exception', async () => {
    const login = new Date('2024-02-01T00:00:00.000Z');
    await db.insert(session).values({
      createdAt: login,
      expiresAt: new Date(Date.now() + 3600_000),
      id: 'keep-2',
      token: 't2',
      updatedAt: login,
      userId: IDS.userAdmin,
    });
    // Seed exception
    await db
      .update(users)
      .set({
        authInvalidatedAt: new Date(),
        authInvalidatedExcludedSessionId: 'keep-2',
      })
      .where(eq(users.id, IDS.userAdmin));

    // Need second super for ban target path — ban target not self
    const caller = createAdminCaller(await ctx(IDS.userAdmin, { sessionId: 'keep-2' }));
    // Ban clears target's exception; ban self is denied — ban IDS.target
    await caller.users.ban({ reason: 'ban target', userId: IDS.target });
    // Ban userAdmin via super
    const superCaller = createAdminCaller(await ctx(IDS.super));
    await superCaller.users.ban({ reason: 'ban admin', userId: IDS.userAdmin });

    const u = await db.query.users.findFirst({ where: eq(users.id, IDS.userAdmin) });
    expect(u?.banned).toBe(true);
    expect(u?.authInvalidatedExcludedSessionId).toBeNull();
  });

  it('includeCurrent=true full revoke clears exception and all sessions', async () => {
    const login = new Date('2024-03-01T00:00:00.000Z');
    await db.insert(session).values({
      createdAt: login,
      expiresAt: new Date(Date.now() + 3600_000),
      id: 's-full',
      token: 'tf',
      updatedAt: login,
      userId: IDS.userAdmin,
    });
    const caller = createAdminCaller(
      await ctx(IDS.userAdmin, {
        credentialIssuedAt: login,
        sessionId: 's-full',
      }),
    );
    await caller.users.revokeSessions({
      includeCurrent: true,
      reason: 'full',
      userId: IDS.userAdmin,
    });
    const u = await db.query.users.findFirst({ where: eq(users.id, IDS.userAdmin) });
    expect(u?.authInvalidatedExcludedSessionId).toBeNull();
    expect(await db.query.session.findFirst({ where: eq(session.id, 's-full') })).toBeUndefined();
  });

  it('rejects preserve when session does not belong to target', async () => {
    await db.insert(session).values({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      id: 'foreign-sess',
      token: 'tf2',
      updatedAt: new Date(),
      userId: IDS.target,
    });
    // Actor claims foreign session id for includeCurrent=false on self — session not owned
    const caller = createAdminCaller(await ctx(IDS.userAdmin, { sessionId: 'foreign-sess' }));
    await expect(
      caller.users.revokeSessions({
        includeCurrent: false,
        reason: 'bad',
        userId: IDS.userAdmin,
      }),
    ).rejects.toBeTruthy();
  });
});

describe('R2-02 credentialIssuedAt vs authenticatedAt', () => {
  it('activeUser uses credentialIssuedAt not authenticatedAt for cutoff', async () => {
    const cutoff = new Date();
    await db
      .update(users)
      .set({ authInvalidatedAt: cutoff, authInvalidatedExcludedSessionId: null })
      .where(eq(users.id, IDS.userAdmin));

    const staleCred = createAdminCaller(
      await ctx(IDS.userAdmin, {
        authenticatedAt: new Date(),
        credentialIssuedAt: new Date(cutoff.getTime() - 10_000),
        sessionId: null,
      }),
    );
    await expect(staleCred.users.list({})).rejects.toBeTruthy();

    const freshCred = createAdminCaller(
      await ctx(IDS.userAdmin, {
        authenticatedAt: new Date(cutoff.getTime() - 3600_000),
        credentialIssuedAt: new Date(cutoff.getTime() + 1000),
      }),
    );
    await expect(freshCred.users.list({ limit: 1 })).resolves.toBeTruthy();
  });
});

describe('R2-03 failed audits persist', () => {
  it('ban not-found leaves failure audit', async () => {
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
  });
});

describe('R2-04 strict recursive output schemas', () => {
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
});
