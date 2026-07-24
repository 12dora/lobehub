// @vitest-environment node
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { verifyPassword } from 'better-auth/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { RbacModel } from '@/database/models/rbac';
import * as schema from '@/database/schemas';
import {
  account,
  permissions,
  rolePermissions,
  roles,
  session,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import {
  assertBootstrapCredentialPassword,
  bootstrapSuperAdmin,
  ensurePlatformRbacSeeded,
} from './superAdmin';

vi.mock('@/envs/auth', () => ({
  authEnv: {
    AUTH_DISABLE_EMAIL_PASSWORD: false,
  },
}));

const db: LobeChatDatabase = await getTestDB();
const userId = 'bootstrap-user';
const STRONG_PASSWORD = 'break-glass-secret-password';
const USER_EMAIL = 'admin@example.com';

/** Minimal Better Auth instance against the test DB — real `/sign-in/email` path. */
const createSignInAuth = (database: LobeChatDatabase) =>
  betterAuth({
    baseURL: 'http://localhost:3000',
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: {
        ...schema,
        user: schema.users,
      },
    }),
    emailAndPassword: { enabled: true },
    secret: 'bootstrap-sign-in-test-secret-32chars!!',
    user: {
      fields: {
        image: 'avatar',
        name: 'fullName',
      },
      modelName: 'users',
    },
  });

const signInWithEmailPassword = async (email: string, password: string) => {
  const auth = createSignInAuth(db);
  // Better Auth default basePath is `/api/auth`.
  const response = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-in/email', {
      body: JSON.stringify({ email, password }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }),
  );
  const body = (await response.json().catch(() => null)) as {
    token?: string;
    user?: { email?: string; id?: string };
  } | null;
  return { body, response };
};

const cleanup = async () => {
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(session);
  await db.delete(account);
  await db.delete(users);
};

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values({
    email: USER_EMAIL,
    emailVerified: true,
    fullName: 'Bootstrap Admin',
    id: userId,
  });
  const { authEnv } = await import('@/envs/auth');
  (authEnv as { AUTH_DISABLE_EMAIL_PASSWORD: boolean }).AUTH_DISABLE_EMAIL_PASSWORD = false;
});

afterEach(async () => {
  await cleanup();
});

describe('bootstrapSuperAdmin', () => {
  it('is idempotent and grants super_admin', async () => {
    const first = await bootstrapSuperAdmin(db, { password: STRONG_PASSWORD, userId });
    expect(first.roleAssigned).toBe(true);
    expect(first.alreadySuperAdmin).toBe(false);

    const second = await bootstrapSuperAdmin(db, { userId });
    expect(second.roleAssigned).toBe(false);
    expect(second.alreadySuperAdmin).toBe(true);

    const rbac = new RbacModel(db, userId);
    expect(await rbac.isGlobalSuperAdmin(userId)).toBe(true);
    expect(await rbac.countActiveSuperAdmins()).toBe(1);
  });

  it('can resolve user by email', async () => {
    const result = await bootstrapSuperAdmin(db, {
      email: USER_EMAIL,
      password: STRONG_PASSWORD,
    });
    expect(result.userId).toBe(userId);
  });

  it('repairs legacy super-admin user that has role but no credential account', async () => {
    // Simulate the previously broken bootstrap: user + role, zero credential accounts.
    const first = await bootstrapSuperAdmin(db, { password: STRONG_PASSWORD, userId });
    expect(first.roleAssigned).toBe(true);
    await db.delete(account);

    const repaired = await bootstrapSuperAdmin(db, {
      password: STRONG_PASSWORD,
      userId,
    });
    expect(repaired.credentialRepaired).toBe(true);
    expect(repaired.createdUser).toBe(false);
    expect(repaired.alreadySuperAdmin).toBe(true);
    expect(repaired.oneTimePassword).toBeUndefined();

    const credential = await db.query.account.findFirst({
      where: (t, { and, eq }) => and(eq(t.userId, userId), eq(t.providerId, 'credential')),
    });
    expect(credential).toBeTruthy();
    expect(credential?.accountId).toBe(userId);
    await expect(
      verifyPassword({ hash: credential!.password!, password: STRONG_PASSWORD }),
    ).resolves.toBe(true);

    // Second run is idempotent — does not rotate the password or re-insert.
    const again = await bootstrapSuperAdmin(db, {
      password: 'different-password-not-applied',
      userId,
    });
    expect(again.credentialRepaired).toBe(false);
    await expect(
      verifyPassword({ hash: credential!.password!, password: STRONG_PASSWORD }),
    ).resolves.toBe(true);
  });

  it('repaired existing-user credential can sign in via Better Auth /sign-in/email', async () => {
    // Existing user, no role, no credential — bootstrap must grant role + credential atomically,
    // then the operator must be able to sign in with the break-glass password.
    const result = await bootstrapSuperAdmin(db, {
      password: STRONG_PASSWORD,
      userId,
    });
    expect(result.roleAssigned).toBe(true);
    expect(result.credentialRepaired).toBe(true);
    expect(result.createdUser).toBe(false);

    const { body, response } = await signInWithEmailPassword(USER_EMAIL, STRONG_PASSWORD);
    expect(response.status).toBe(200);
    expect(body?.token).toBeTruthy();
    expect(body?.user?.id).toBe(userId);
    expect(body?.user?.email).toBe(USER_EMAIL);

    // Wrong password must not mint a session.
    const bad = await signInWithEmailPassword(USER_EMAIL, 'wrong-password-not-accepted');
    expect(bad.response.ok).toBe(false);
    expect(bad.body?.token).toBeUndefined();
  });

  it('does not grant super_admin when existing-user password validation fails', async () => {
    await expect(
      bootstrapSuperAdmin(db, {
        password: 'short',
        userId,
      }),
    ).rejects.toThrow(/8–64/);

    const rbac = new RbacModel(db, userId);
    expect(await rbac.isGlobalSuperAdmin(userId)).toBe(false);
    const credential = await db.query.account.findFirst({
      where: (t, { and, eq }) => and(eq(t.userId, userId), eq(t.providerId, 'credential')),
    });
    expect(credential).toBeUndefined();
  });

  it('does not grant super_admin when credential repair is refused (auth disabled)', async () => {
    const { authEnv } = await import('@/envs/auth');
    (authEnv as { AUTH_DISABLE_EMAIL_PASSWORD: boolean }).AUTH_DISABLE_EMAIL_PASSWORD = true;

    await expect(
      bootstrapSuperAdmin(db, {
        password: STRONG_PASSWORD,
        userId,
      }),
    ).rejects.toThrow(/AUTH_DISABLE_EMAIL_PASSWORD/);

    const rbac = new RbacModel(db, userId);
    expect(await rbac.isGlobalSuperAdmin(userId)).toBe(false);
  });

  it('generates a one-time password when repairing credentialless bootstrap user', async () => {
    await bootstrapSuperAdmin(db, { password: STRONG_PASSWORD, userId });
    await db.delete(account);

    const repaired = await bootstrapSuperAdmin(db, { userId });
    expect(repaired.credentialRepaired).toBe(true);
    expect(repaired.oneTimePassword).toBeTruthy();

    const credential = await db.query.account.findFirst({
      where: (t, { and, eq }) => and(eq(t.userId, userId), eq(t.providerId, 'credential')),
    });
    await expect(
      verifyPassword({
        hash: credential!.password!,
        password: repaired.oneTimePassword!,
      }),
    ).resolves.toBe(true);

    // One-time password must work for real credential sign-in as well.
    const { body, response } = await signInWithEmailPassword(USER_EMAIL, repaired.oneTimePassword!);
    expect(response.status).toBe(200);
    expect(body?.token).toBeTruthy();
    expect(body?.user?.id).toBe(userId);
  });

  it('creates break-glass user with credential that Better Auth can verify', async () => {
    await db.delete(account);
    await db.delete(users);
    // Leading/trailing spaces must be preserved (not trimmed) for privileged secrets.
    const passwordWithSpaces = `  ${STRONG_PASSWORD}  `;
    const result = await bootstrapSuperAdmin(db, {
      allowCreate: true,
      email: 'break@localhost',
      password: passwordWithSpaces,
      username: 'breakglass',
    });
    expect(result.createdUser).toBe(true);
    expect(result.oneTimePassword).toBeUndefined();
    const rbac = new RbacModel(db, result.userId);
    expect(await rbac.isGlobalSuperAdmin(result.userId)).toBe(true);

    const credential = await db.query.account.findFirst({
      where: (t, { and, eq }) => and(eq(t.userId, result.userId), eq(t.providerId, 'credential')),
    });
    expect(credential).toBeTruthy();
    expect(credential?.password).toBeTruthy();
    expect(credential?.password).not.toBe(passwordWithSpaces);
    expect(credential?.accountId).toBe(result.userId);
    // Real Better Auth scrypt verify — same path credential sign-in uses.
    await expect(
      verifyPassword({ hash: credential!.password!, password: passwordWithSpaces }),
    ).resolves.toBe(true);
    await expect(
      verifyPassword({ hash: credential!.password!, password: STRONG_PASSWORD }),
    ).resolves.toBe(false);
  });

  it('rejects weak or overlong supplied passwords', async () => {
    await db.delete(account);
    await db.delete(users);
    await expect(
      bootstrapSuperAdmin(db, {
        allowCreate: true,
        email: 'weak@localhost',
        password: 'short',
        username: 'weak',
      }),
    ).rejects.toThrow(/8–64/);
    await expect(
      bootstrapSuperAdmin(db, {
        allowCreate: true,
        email: 'long@localhost',
        password: 'a'.repeat(65),
        username: 'long',
      }),
    ).rejects.toThrow(/8–64/);
    expect(assertBootstrapCredentialPassword(STRONG_PASSWORD)).toBeUndefined();
  });

  it('refuses break-glass create when email/password auth is disabled', async () => {
    await db.delete(account);
    await db.delete(users);
    const { authEnv } = await import('@/envs/auth');
    (authEnv as { AUTH_DISABLE_EMAIL_PASSWORD: boolean }).AUTH_DISABLE_EMAIL_PASSWORD = true;
    await expect(
      bootstrapSuperAdmin(db, {
        allowCreate: true,
        email: 'disabled@localhost',
        password: STRONG_PASSWORD,
        username: 'disabled',
      }),
    ).rejects.toThrow(/AUTH_DISABLE_EMAIL_PASSWORD/);
  });

  it('generates a one-time password when create password is omitted', async () => {
    await db.delete(account);
    await db.delete(users);
    const result = await bootstrapSuperAdmin(db, {
      allowCreate: true,
      email: 'generated@localhost',
      username: 'breakglass2',
    });
    expect(result.createdUser).toBe(true);
    expect(result.oneTimePassword).toBeTruthy();
    expect(result.oneTimePassword!.length).toBeGreaterThanOrEqual(16);

    const credential = await db.query.account.findFirst({
      where: (t, { and, eq }) => and(eq(t.userId, result.userId), eq(t.providerId, 'credential')),
    });
    expect(credential?.password).toBeTruthy();
    expect(credential?.password).not.toBe(result.oneTimePassword);
    await expect(
      verifyPassword({
        hash: credential!.password!,
        password: result.oneTimePassword!,
      }),
    ).resolves.toBe(true);
  });

  it('ensurePlatformRbacSeeded seeds roles without promoting users', async () => {
    const { superAdminCount } = await ensurePlatformRbacSeeded(db);
    expect(superAdminCount).toBe(0);
    const role = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    expect(role).toBeTruthy();
  });
});
