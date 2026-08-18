/**
 * admin.users.setPassword + disableTwoFactor coverage.
 * @vitest-environment node
 */
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  account,
  passkey,
  permissions,
  platformAuditLogs,
  rolePermissions,
  roles,
  session,
  twoFactor,
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
  plain: 'cred-plain',
  sso: 'cred-sso',
  super: 'cred-super',
  target: 'cred-target',
  userAdmin: 'cred-user-admin',
};

const NEW_PASSWORD = 'N3w-secure-pass!x';

const cleanup = async () => {
  await db.delete(session);
  await db.delete(twoFactor);
  await db.delete(passkey);
  await db.delete(account);
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

const seedCredentialAccount = async (userId: string, password: string) => {
  const passwordHash = await hashPassword(password);
  await db.insert(account).values({
    accountId: userId,
    id: `acct-${userId}`,
    password: passwordHash,
    providerId: 'credential',
    updatedAt: new Date(),
    userId,
  });
  return passwordHash;
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
  await grant(IDS.plain, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
  await grant(IDS.target, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
  await grant(IDS.sso, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
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

describe('admin.users.setPassword', () => {
  it('writes a better-auth scrypt hash that verifyPassword accepts and revokes sessions', async () => {
    await seedCredentialAccount(IDS.target, 'Old-pass!1234');
    await db.insert(session).values({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      id: 'target-sess',
      token: 'tok-target-setpw',
      updatedAt: new Date(),
      userId: IDS.target,
    });

    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const caller = createAdminCaller(await ctx(IDS.userAdmin, { authenticatedAt: stale }));
    const result = await caller.users.setPassword({
      newPassword: NEW_PASSWORD,
      userId: IDS.target,
    });
    expect(result).toEqual({ sessionsRevoked: true, userId: IDS.target });

    const acct = await db.query.account.findFirst({ where: eq(account.userId, IDS.target) });
    expect(acct?.providerId).toBe('credential');
    expect(acct?.password).toBeTruthy();
    expect(acct?.password).not.toBe(NEW_PASSWORD);
    await expect(verifyPassword({ hash: acct!.password!, password: NEW_PASSWORD })).resolves.toBe(
      true,
    );

    expect(
      await db.query.session.findFirst({ where: eq(session.id, 'target-sess') }),
    ).toBeUndefined();
    const after = await db.query.users.findFirst({ where: eq(users.id, IDS.target) });
    expect(after?.authInvalidatedAt).toBeInstanceOf(Date);

    const audits = await db.query.platformAuditLogs.findMany({
      where: eq(platformAuditLogs.action, 'admin.users.setPassword'),
    });
    const success = audits.filter((a) => a.result === 'success' && a.targetId === IDS.target);
    expect(success).toHaveLength(1);
    expect(success[0]?.reason ?? null).toBeNull();
    const auditJson = JSON.stringify(audits);
    expect(auditJson).not.toContain(NEW_PASSWORD);
    expect(auditJson).not.toContain(acct!.password!);
  });

  it('rejects an SSO-only user (no credential account)', async () => {
    await db.insert(account).values({
      accountId: 'google-sub',
      id: 'acct-sso',
      providerId: 'google',
      updatedAt: new Date(),
      userId: IDS.sso,
    });

    const caller = createAdminCaller(await ctx(IDS.super));
    await expect(
      caller.users.setPassword({
        newPassword: NEW_PASSWORD,
        userId: IDS.sso,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: {
        data: { code: 'PLATFORM_INVALID_INPUT', details: { reason: 'no_credential_account' } },
      },
    });

    const failures = (
      await db.query.platformAuditLogs.findMany({
        where: eq(platformAuditLogs.action, 'admin.users.setPassword'),
      })
    ).filter((a) => a.result === 'failure');
    expect(
      failures.some((a) => (a.afterDiff as { error?: string })?.error === 'no_credential_account'),
    ).toBe(true);
  });

  it('rejects setting your own password', async () => {
    await seedCredentialAccount(IDS.super, 'Old-pass!1234');
    const caller = createAdminCaller(await ctx(IDS.super));
    await expect(
      caller.users.setPassword({
        newPassword: NEW_PASSWORD,
        userId: IDS.super,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: {
        data: { code: 'PLATFORM_INVALID_INPUT', details: { reason: 'self_set_password' } },
      },
    });
    const denied = (
      await db.query.platformAuditLogs.findMany({
        where: eq(platformAuditLogs.action, 'admin.users.setPassword'),
      })
    ).filter((a) => a.result === 'denied');
    expect(
      denied.some((a) => (a.afterDiff as { error?: string })?.error === 'self_set_password'),
    ).toBe(true);
  });

  it('rejects a password shorter than the minimum', async () => {
    await seedCredentialAccount(IDS.target, 'Old-pass!1234');
    const caller = createAdminCaller(await ctx(IDS.super));
    await expect(
      caller.users.setPassword({
        newPassword: 'short',
        userId: IDS.target,
      }),
    ).rejects.toBeTruthy();
  });

  it('does not bump the security epoch when revokeSessions is false', async () => {
    await seedCredentialAccount(IDS.target, 'Old-pass!1234');
    await db.insert(session).values({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      id: 'keep-sess',
      token: 'tok-keep',
      updatedAt: new Date(),
      userId: IDS.target,
    });
    const before = await db.query.users.findFirst({ where: eq(users.id, IDS.target) });

    const caller = createAdminCaller(await ctx(IDS.super));
    const result = await caller.users.setPassword({
      newPassword: NEW_PASSWORD,
      revokeSessions: false,
      userId: IDS.target,
    });
    expect(result.sessionsRevoked).toBe(false);
    expect(await db.query.session.findFirst({ where: eq(session.id, 'keep-sess') })).toBeTruthy();
    const after = await db.query.users.findFirst({ where: eq(users.id, IDS.target) });
    expect(after?.authInvalidatedAt?.getTime() ?? null).toBe(
      before?.authInvalidatedAt?.getTime() ?? null,
    );
  });

  it('denies setPassword without USER_CREDENTIAL_MANAGE', async () => {
    await seedCredentialAccount(IDS.target, 'Old-pass!1234');
    const caller = createAdminCaller(await ctx(IDS.plain));
    await expect(
      caller.users.setPassword({
        newPassword: NEW_PASSWORD,
        userId: IDS.target,
      }),
    ).rejects.toBeTruthy();
  });
});

describe('admin.users.disableTwoFactor', () => {
  const seedFactors = async () => {
    await db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, IDS.target));
    await db.insert(twoFactor).values({
      backupCodes: 'enc-backup-codes',
      id: 'tf-target',
      secret: 'totp-secret',
      userId: IDS.target,
      verified: true,
    });
    await db.insert(passkey).values({
      credentialID: 'cred-target-1',
      id: 'pk-target',
      publicKey: 'public-key-bytes',
      userId: IDS.target,
    });
    await db.insert(session).values({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      id: 'tf-sess',
      token: 'tok-tf',
      updatedAt: new Date(),
      userId: IDS.target,
    });
  };

  it('clears two_factor rows, flips the flag, and is idempotent', async () => {
    await seedFactors();
    const caller = createAdminCaller(await ctx(IDS.userAdmin));

    const first = await caller.users.disableTwoFactor({
      userId: IDS.target,
    });
    expect(first).toEqual({
      passkeysRemoved: false,
      twoFactorEnabled: false,
      userId: IDS.target,
    });

    expect(
      await db.query.twoFactor.findMany({ where: eq(twoFactor.userId, IDS.target) }),
    ).toHaveLength(0);
    expect(await db.query.passkey.findMany({ where: eq(passkey.userId, IDS.target) })).toHaveLength(
      1,
    );
    const after = await db.query.users.findFirst({ where: eq(users.id, IDS.target) });
    expect(after?.twoFactorEnabled).toBe(false);
    expect(after?.authInvalidatedAt).toBeInstanceOf(Date);
    expect(await db.query.session.findFirst({ where: eq(session.id, 'tf-sess') })).toBeUndefined();

    const second = await caller.users.disableTwoFactor({
      userId: IDS.target,
    });
    expect(second.twoFactorEnabled).toBe(false);

    const audits = await db.query.platformAuditLogs.findMany({
      where: eq(platformAuditLogs.action, 'admin.users.disableTwoFactor'),
    });
    const success = audits.filter((a) => a.result === 'success' && a.targetId === IDS.target);
    expect(success).toHaveLength(2);
    expect(success.every((a) => (a.reason ?? null) === null)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('totp-secret');
    expect(JSON.stringify(audits)).not.toContain('enc-backup-codes');
  });

  it('removes passkeys only when removePasskeys is true', async () => {
    await seedFactors();
    const caller = createAdminCaller(await ctx(IDS.super));

    await caller.users.disableTwoFactor({
      userId: IDS.target,
    });
    expect(await db.query.passkey.findMany({ where: eq(passkey.userId, IDS.target) })).toHaveLength(
      1,
    );

    await caller.users.disableTwoFactor({
      removePasskeys: true,
      userId: IDS.target,
    });
    expect(await db.query.passkey.findMany({ where: eq(passkey.userId, IDS.target) })).toHaveLength(
      0,
    );
  });

  it('denies disableTwoFactor without USER_CREDENTIAL_MANAGE', async () => {
    await seedFactors();
    const caller = createAdminCaller(await ctx(IDS.plain));
    await expect(caller.users.disableTwoFactor({ userId: IDS.target })).rejects.toBeTruthy();
    expect(
      await db.query.twoFactor.findMany({ where: eq(twoFactor.userId, IDS.target) }),
    ).toHaveLength(1);
  });
});

describe('admin.users.get credential surface', () => {
  it('returns twoFactorEnabled, passkeyCount, and hasPassword without secrets', async () => {
    await seedCredentialAccount(IDS.target, 'Old-pass!1234');
    await db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, IDS.target));
    await db.insert(twoFactor).values({
      backupCodes: 'enc-backup-codes',
      id: 'tf-get',
      secret: 'totp-secret-get',
      userId: IDS.target,
      verified: true,
    });
    await db.insert(passkey).values([
      {
        credentialID: 'cred-get-1',
        id: 'pk-get-1',
        publicKey: 'public-key-1',
        userId: IDS.target,
      },
      {
        credentialID: 'cred-get-2',
        id: 'pk-get-2',
        publicKey: 'public-key-2',
        userId: IDS.target,
      },
    ]);

    const caller = createAdminCaller(await ctx(IDS.userAdmin));
    const detail = await caller.users.get({ userId: IDS.target });
    expect(detail).toMatchObject({
      hasPassword: true,
      passkeyCount: 2,
      twoFactorEnabled: true,
    });
    const json = JSON.stringify(detail);
    expect(json).not.toContain('Old-pass!1234');
    expect(json).not.toContain('totp-secret-get');
    expect(json).not.toContain('enc-backup-codes');
    expect(json).not.toContain('public-key-1');

    const sso = await caller.users.get({ userId: IDS.sso });
    expect(sso).toMatchObject({
      hasPassword: false,
      passkeyCount: 0,
      twoFactorEnabled: false,
    });
  });
});
