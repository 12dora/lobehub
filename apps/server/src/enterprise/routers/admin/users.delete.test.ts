/**
 * admin.users.delete (hard delete) + targeted revokeSessions coverage.
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
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

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
  super: 'del-super',
  super2: 'del-super-2',
  target: 'del-target',
  userAdmin: 'del-user-admin',
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
    where: (t, { and, eq: e, isNull }) => and(e(t.name, roleName), isNull(t.workspaceId)),
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
    sessionId?: string | null;
  },
) => {
  const now = new Date();
  const base = await createContextInner({
    authenticatedAt: extras && 'authenticatedAt' in extras ? extras.authenticatedAt : now,
    authMethod: extras?.authMethod ?? 'better-auth',
    credentialIssuedAt: now,
    sessionId: extras?.sessionId ?? 'actor-sess',
    userId,
  });
  return { ...base, serverDB: db } as never;
};

describe('admin.users.delete (hard delete)', () => {
  it('hard-deletes the user and cascades owned rows; keeps the success audit', async () => {
    await db.insert(session).values({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      id: 'target-sess',
      token: 'tok-target',
      updatedAt: new Date(),
      userId: IDS.target,
    });

    const caller = createAdminCaller(await ctx(IDS.super));
    const result = await caller.users.delete({ reason: 'gdpr', userId: IDS.target });
    expect(result).toEqual({ deleted: true, userId: IDS.target });

    expect(await db.query.users.findFirst({ where: eq(users.id, IDS.target) })).toBeUndefined();
    expect(await db.query.session.findMany({ where: eq(session.userId, IDS.target) })).toHaveLength(
      0,
    );
    expect(
      await db.query.userRoles.findMany({ where: eq(userRoles.userId, IDS.target) }),
    ).toHaveLength(0);

    const audits = await db.query.platformAuditLogs.findMany({
      where: eq(platformAuditLogs.action, 'admin.users.delete'),
    });
    const success = audits.filter((a) => a.result === 'success' && a.targetId === IDS.target);
    expect(success).toHaveLength(1);
    // never persist tokens
    expect(JSON.stringify(audits)).not.toMatch(/tok-target|token/i);
  });

  it('blocks deleting yourself with a denied audit', async () => {
    const caller = createAdminCaller(await ctx(IDS.super));
    await expect(caller.users.delete({ reason: 'self', userId: IDS.super })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { data: { code: 'PLATFORM_INVALID_INPUT', details: { reason: 'self_delete' } } },
    });
    expect(await db.query.users.findFirst({ where: eq(users.id, IDS.super) })).toBeTruthy();
    const denied = (
      await db.query.platformAuditLogs.findMany({
        where: eq(platformAuditLogs.action, 'admin.users.delete'),
      })
    ).filter((a) => a.result === 'denied');
    expect(denied.some((a) => (a.afterDiff as { error?: string })?.error === 'self_delete')).toBe(
      true,
    );
  });

  it('blocks deleting the last permanent super admin', async () => {
    // super is the only super_admin; user_admin holds USER_DELETE.
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    await expect(
      caller.users.delete({ reason: 'remove super', userId: IDS.super }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { data: { code: 'PLATFORM_LAST_SUPER_ADMIN' } },
    });
    expect(await db.query.users.findFirst({ where: eq(users.id, IDS.super) })).toBeTruthy();
  });

  it('allows deleting a super admin while another active super remains', async () => {
    await grant(IDS.super2, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    const caller = createAdminCaller(await ctx(IDS.super));
    await expect(caller.users.delete({ reason: 'demote', userId: IDS.super2 })).resolves.toEqual({
      deleted: true,
      userId: IDS.super2,
    });
    expect(await db.query.users.findFirst({ where: eq(users.id, IDS.super2) })).toBeUndefined();
    expect(await db.query.users.findFirst({ where: eq(users.id, IDS.super) })).toBeTruthy();
  });

  it('rejects deleting a missing user with a failure audit', async () => {
    const caller = createAdminCaller(await ctx(IDS.super));
    await expect(
      caller.users.delete({ reason: 'ghost', userId: 'does-not-exist' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const audits = await db.query.platformAuditLogs.findMany({
      where: eq(platformAuditLogs.action, 'admin.users.delete'),
    });
    expect(audits.some((a) => a.result === 'failure' && a.targetId === 'does-not-exist')).toBe(
      true,
    );
  });

  it('requires recent reauth and records a denied audit when stale', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const caller = createAdminCaller(await ctx(IDS.super, { authenticatedAt: stale }));
    await expect(caller.users.delete({ reason: 'stale', userId: IDS.target })).rejects.toBeTruthy();
    // Target must survive the reauth failure.
    expect(await db.query.users.findFirst({ where: eq(users.id, IDS.target) })).toBeTruthy();
    const denied = (
      await db.query.platformAuditLogs.findMany({
        where: eq(platformAuditLogs.action, 'admin.users.delete'),
      })
    ).filter((a) => a.result === 'denied');
    expect(
      denied.some((a) => (a.afterDiff as { error?: string })?.error === 'reauth_required'),
    ).toBe(true);
  });

  it('denies delete for a role without USER_DELETE', async () => {
    // target holds only platform_user — no USER_DELETE.
    const caller = createAdminCaller(await ctx(IDS.target));
    await expect(
      caller.users.delete({ reason: 'nope', userId: IDS.userAdmin }),
    ).rejects.toBeTruthy();
    expect(await db.query.users.findFirst({ where: eq(users.id, IDS.userAdmin) })).toBeTruthy();
  });
});

describe('admin.users.revokeSessions (targeted)', () => {
  const seedSessions = async (ids: string[], userId: string) => {
    await db.insert(session).values(
      ids.map((id) => ({
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
        id,
        token: `tok-${id}`,
        updatedAt: new Date(),
        userId,
      })),
    );
  };

  it('revokes only the listed sessions and does not advance the epoch', async () => {
    await seedSessions(['t-s1', 't-s2', 't-s3'], IDS.target);
    const before = await db.query.users.findFirst({ where: eq(users.id, IDS.target) });

    const caller = createAdminCaller(await ctx(IDS.super));
    const res = await caller.users.revokeSessions({
      reason: 'targeted',
      sessionIds: ['t-s1', 't-s2'],
      userId: IDS.target,
    });
    expect(res.revokedCount).toBe(2);

    expect(await db.query.session.findFirst({ where: eq(session.id, 't-s1') })).toBeUndefined();
    expect(await db.query.session.findFirst({ where: eq(session.id, 't-s2') })).toBeUndefined();
    expect(await db.query.session.findFirst({ where: eq(session.id, 't-s3') })).toBeTruthy();

    // Targeted revoke must not advance the global security epoch.
    const after = await db.query.users.findFirst({ where: eq(users.id, IDS.target) });
    expect(after?.authInvalidatedAt?.getTime() ?? null).toBe(
      before?.authInvalidatedAt?.getTime() ?? null,
    );

    const audits = await db.query.platformAuditLogs.findMany({
      where: eq(platformAuditLogs.action, 'admin.users.revokeSessions'),
    });
    expect(
      audits.some(
        (a) => a.result === 'success' && (a.afterDiff as { mode?: string })?.mode === 'targeted',
      ),
    ).toBe(true);
    expect(JSON.stringify(audits)).not.toMatch(/tok-t-s|token/i);
  });

  it('rejects targeted revoke referencing a foreign session id', async () => {
    await seedSessions(['own-1'], IDS.target);
    await seedSessions(['foreign-1'], IDS.userAdmin);
    const caller = createAdminCaller(await ctx(IDS.super));
    await expect(
      caller.users.revokeSessions({
        reason: 'mixed',
        sessionIds: ['own-1', 'foreign-1'],
        userId: IDS.target,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: {
        data: { code: 'PLATFORM_INVALID_INPUT', details: { reason: 'retained_session_invalid' } },
      },
    });
    // No rows deleted on rejection.
    expect(await db.query.session.findFirst({ where: eq(session.id, 'own-1') })).toBeTruthy();
    expect(await db.query.session.findFirst({ where: eq(session.id, 'foreign-1') })).toBeTruthy();
  });
});

describe('admin.users.replaceGlobalRoles (per-role revoke preserves expiry)', () => {
  const grantWithExpiry = async (userId: string, roleName: string, expiresAt: Date) => {
    const role = await db.query.roles.findFirst({
      where: (t, { and, eq: e, isNull }) => and(e(t.name, roleName), isNull(t.workspaceId)),
    });
    if (!role) throw new Error(roleName);
    await db.insert(userRoles).values({ expiresAt, roleId: role.id, userId, workspaceId: null });
  };

  it('keeps the remaining role expiry when one role is revoked via preserveRoleNames', async () => {
    // target starts with platform_user (permanent, from beforeEach). Add a temporary auditor.
    const auditorExpiry = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await grantWithExpiry(IDS.target, PLATFORM_SYSTEM_ROLES.AUDITOR, auditorExpiry);

    const roleId = async (name: string) => {
      const r = await db.query.roles.findFirst({
        where: (t, { and, eq: e, isNull }) => and(e(t.name, name), isNull(t.workspaceId)),
      });
      return r!.id;
    };
    const auditorRoleId = await roleId(PLATFORM_SYSTEM_ROLES.AUDITOR);
    const platformUserRoleId = await roleId(PLATFORM_SYSTEM_ROLES.PLATFORM_USER);

    const caller = createAdminCaller(await ctx(IDS.super));
    // Revoke platform_user; keep auditor untouched (preserve its finite expiry).
    await caller.users.replaceGlobalRoles({
      preserveRoleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
      reason: 'revoke platform_user',
      roleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
      userId: IDS.target,
    });

    const grants = await db.query.userRoles.findMany({
      where: eq(userRoles.userId, IDS.target),
    });
    const platformUserGrant = grants.find((g) => g.roleId === platformUserRoleId);
    const auditorGrant = grants.find((g) => g.roleId === auditorRoleId);
    expect(platformUserGrant).toBeUndefined();
    expect(auditorGrant).toBeTruthy();
    // Expiry must be preserved, NOT wiped to permanent.
    expect(auditorGrant?.expiresAt?.getTime()).toBe(auditorExpiry.getTime());
  });
});
