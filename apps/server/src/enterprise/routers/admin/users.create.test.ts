/**
 * admin.users.create (credential user provisioning) coverage.
 * @vitest-environment node
 */
import { verifyPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  account,
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
import { authEnv } from '@/envs/auth';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { adminRouter } from '../admin';

let db: LobeChatDatabase;

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

// Mutable copy so tests can flip AUTH_DISABLE_EMAIL_PASSWORD (read at call time).
vi.mock('@/envs/auth', async (importOriginal) => {
  const actual = (await importOriginal()) as { authEnv: Record<string, unknown> };
  return { ...actual, authEnv: { ...actual.authEnv } };
});

const createAdminCaller = createCallerFactory(adminRouter);

const IDS = {
  plain: 'crt-plain',
  super: 'crt-super',
  userAdmin: 'crt-user-admin',
};

const PASSWORD = 'S3cure-pass!x';

const cleanup = async () => {
  await db.delete(session);
  await db.delete(account);
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
  (authEnv as { AUTH_DISABLE_EMAIL_PASSWORD: boolean }).AUTH_DISABLE_EMAIL_PASSWORD = false;
  await cleanup();
  await db.insert(users).values(Object.values(IDS).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await grant(IDS.super, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  await grant(IDS.userAdmin, PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  await grant(IDS.plain, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
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

describe('admin.users.create (credential user)', () => {
  it('creates user + credential account + platform_user role atomically', async () => {
    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    const result = await caller.users.create({
      email: '  New.User@Example.COM ',
      fullName: 'New User',
      password: PASSWORD,
      reason: 'onboard new hire',
      username: 'new.user-1',
    });

    expect(result).toEqual({
      created: true,
      email: 'new.user@example.com',
      userId: expect.stringMatching(/^user_[\da-f]{12}$/),
    });

    const created = await db.query.users.findFirst({ where: eq(users.id, result.userId) });
    expect(created?.email).toBe('new.user@example.com');
    expect(created?.normalizedEmail).toBe('new.user@example.com');
    expect(created?.username).toBe('new.user-1');
    expect(created?.fullName).toBe('New User');
    expect(created?.emailVerified).toBe(true);
    expect(created?.onboarding).toEqual({ finishedAt: expect.any(String), version: 1 });

    // Better Auth credential account: scrypt hash verifies and never stores plaintext.
    // accountId is the LOCAL user id (credential convention) — never the email.
    const acct = await db.query.account.findFirst({ where: eq(account.userId, result.userId) });
    expect(acct?.providerId).toBe('credential');
    expect(acct?.accountId).toBe(result.userId);
    expect(acct?.password).toBeTruthy();
    expect(acct?.password).not.toBe(PASSWORD);
    await expect(verifyPassword({ hash: acct!.password!, password: PASSWORD })).resolves.toBe(true);

    // platform_user global role assigned.
    const platformUserRole = await db.query.roles.findFirst({
      where: (t, { and, eq: e, isNull }) =>
        and(e(t.name, PLATFORM_SYSTEM_ROLES.PLATFORM_USER), isNull(t.workspaceId)),
    });
    const grants = await db.query.userRoles.findMany({
      where: eq(userRoles.userId, result.userId),
    });
    expect(grants.map((g) => g.roleId)).toEqual([platformUserRole!.id]);

    // Success audit exists and never contains password material (raw or hash).
    const audits = await db.query.platformAuditLogs.findMany({
      where: eq(platformAuditLogs.action, 'admin.users.create'),
    });
    const success = audits.filter((a) => a.result === 'success' && a.targetId === result.userId);
    expect(success).toHaveLength(1);
    const auditJson = JSON.stringify(audits);
    expect(auditJson).not.toContain(PASSWORD);
    expect(auditJson).not.toContain(acct!.password!);
    expect(auditJson).not.toMatch(/password/i);
  });

  it('rejects a duplicate email with a failure audit and writes no rows', async () => {
    const caller = createAdminCaller(await ctx(IDS.super));
    await caller.users.create({
      email: 'taken@example.com',
      fullName: 'First',
      password: PASSWORD,
      reason: 'first',
    });

    const usersBefore = await db.query.users.findMany();
    const accountsBefore = await db.query.account.findMany();

    await expect(
      caller.users.create({
        email: 'Taken@Example.com',
        fullName: 'Second',
        password: PASSWORD,
        reason: 'dup',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { data: { code: 'PLATFORM_INVALID_INPUT', details: { reason: 'email_taken' } } },
    });

    expect(await db.query.users.findMany()).toHaveLength(usersBefore.length);
    expect(await db.query.account.findMany()).toHaveLength(accountsBefore.length);

    const failures = (
      await db.query.platformAuditLogs.findMany({
        where: eq(platformAuditLogs.action, 'admin.users.create'),
      })
    ).filter((a) => a.result === 'failure');
    expect(failures.some((a) => (a.afterDiff as { error?: string })?.error === 'email_taken')).toBe(
      true,
    );
  });

  it('rejects create when email/password auth is disabled instance-wide', async () => {
    (authEnv as { AUTH_DISABLE_EMAIL_PASSWORD: boolean }).AUTH_DISABLE_EMAIL_PASSWORD = true;
    const caller = createAdminCaller(await ctx(IDS.userAdmin));

    await expect(
      caller.users.create({
        email: 'disabled@example.com',
        fullName: 'Disabled',
        password: PASSWORD,
        reason: 'should fail',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: {
        data: {
          code: 'PLATFORM_INVALID_INPUT',
          details: { reason: 'password_auth_disabled' },
        },
      },
    });

    // No user row written; failure audit records the machine-readable reason.
    expect(
      await db.query.users.findFirst({ where: eq(users.email, 'disabled@example.com') }),
    ).toBeUndefined();
    const failures = (
      await db.query.platformAuditLogs.findMany({
        where: eq(platformAuditLogs.action, 'admin.users.create'),
      })
    ).filter((a) => a.result === 'failure');
    expect(
      failures.some((a) => (a.afterDiff as { error?: string })?.error === 'password_auth_disabled'),
    ).toBe(true);
  });

  it('denies create for a role without USER_CREATE', async () => {
    const caller = createAdminCaller(await ctx(IDS.plain));
    await expect(
      caller.users.create({
        email: 'nope@example.com',
        fullName: 'Nope',
        password: PASSWORD,
        reason: 'nope',
      }),
    ).rejects.toBeTruthy();
    expect(
      await db.query.users.findFirst({ where: eq(users.email, 'nope@example.com') }),
    ).toBeUndefined();
  });

  it('requires recent reauth and records a denied audit when stale', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const caller = createAdminCaller(await ctx(IDS.super, { authenticatedAt: stale }));
    await expect(
      caller.users.create({
        email: 'stale@example.com',
        fullName: 'Stale',
        password: PASSWORD,
        reason: 'stale',
      }),
    ).rejects.toBeTruthy();

    expect(
      await db.query.users.findFirst({ where: eq(users.email, 'stale@example.com') }),
    ).toBeUndefined();
    const denied = (
      await db.query.platformAuditLogs.findMany({
        where: eq(platformAuditLogs.action, 'admin.users.create'),
      })
    ).filter((a) => a.result === 'denied');
    expect(
      denied.some((a) => (a.afterDiff as { error?: string })?.error === 'reauth_required'),
    ).toBe(true);
  });
});
