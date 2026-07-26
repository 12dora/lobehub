/**
 * Super-admin bootstrap (G-04) + break-glass local account support (G-05).
 *
 * Invocation (ops only, DB access required — not a web endpoint):
 *   bun --env-file=.env.development apps/server/src/enterprise/bootstrap/superAdmin.ts
 *
 * Env:
 *   BOOTSTRAP_SUPER_ADMIN_USER_ID  — existing user id to promote (preferred)
 *   BOOTSTRAP_SUPER_ADMIN_EMAIL    — find user by email if id unset
 *   BOOTSTRAP_ALLOW_CREATE=1       — create a local break-glass user when missing
 *   BOOTSTRAP_REPAIR_CREDENTIAL=1  — for an existing user, also provision a local
 *                                    Better Auth credential if missing (break-glass).
 *                                    Default off: existing-user bootstrap only assigns
 *                                    the super_admin RBAC role (OIDC-safe).
 *   BOOTSTRAP_SUPER_ADMIN_USERNAME — username when creating
 *   BOOTSTRAP_SUPER_ADMIN_PASSWORD — password when creating/repairing (optional; a one-time
 *                                    password is generated and printed when unset).
 *                                    Must satisfy Better Auth 8–64 char policy; bytes
 *                                    are preserved exactly (no trim).
 *
 * Idempotent: re-running is safe. Never auto-promotes the first registered user.
 * Refuses create/credential-repair when AUTH_DISABLE_EMAIL_PASSWORD is enabled.
 */
import { randomBytes } from 'node:crypto';

import { hashPassword } from 'better-auth/crypto';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { AdminUserModel } from '@/database/models/adminUser';
import { RbacModel } from '@/database/models/rbac';
import { account } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { authEnv } from '@/envs/auth';

/** Mirrors Better Auth minPasswordLength / maxPasswordLength in define-config. */
export const BOOTSTRAP_PASSWORD_MIN_LENGTH = 8;
export const BOOTSTRAP_PASSWORD_MAX_LENGTH = 64;

export const assertBootstrapCredentialPassword = (password: string): void => {
  // Preserve operator-supplied bytes exactly — do not trim privileged secrets.
  if (
    password.length < BOOTSTRAP_PASSWORD_MIN_LENGTH ||
    password.length > BOOTSTRAP_PASSWORD_MAX_LENGTH
  ) {
    throw new Error(
      `BOOTSTRAP_SUPER_ADMIN_PASSWORD must be ${BOOTSTRAP_PASSWORD_MIN_LENGTH}–${BOOTSTRAP_PASSWORD_MAX_LENGTH} characters (Better Auth credential policy)`,
    );
  }
};

export interface BootstrapSuperAdminResult {
  alreadySuperAdmin: boolean;
  createdUser: boolean;
  /** True when a missing credential account was provisioned for an existing user. */
  credentialRepaired: boolean;
  /**
   * One-time plaintext password returned only when a break-glass credential was
   * created/repaired and the password was generated (not supplied). Print once; never re-fetchable.
   */
  oneTimePassword?: string;
  roleAssigned: boolean;
  userId: string;
}

export interface BootstrapSuperAdminParams {
  allowCreate?: boolean;
  email?: string | null;
  /** Required when creating/repairing unless omitted — then a secure one-time password is generated. */
  password?: string | null;
  /**
   * When true, provision/repair a local Better Auth credential for an existing user.
   * Default false: existing-user bootstrap only assigns the super_admin role (OIDC-safe).
   * Create path (`allowCreate`) always provisions a credential regardless of this flag.
   */
  repairCredential?: boolean;
  userId?: string | null;
  username?: string | null;
}

const generateEntityId = (prefix: string): string => prefix + randomBytes(6).toString('hex');

/** URL-safe one-time credential material (never stored; only returned once when generated). */
const generateOneTimePassword = (): string => randomBytes(24).toString('base64url');

export const bootstrapSuperAdmin = async (
  db: LobeChatDatabase,
  params: BootstrapSuperAdminParams,
): Promise<BootstrapSuperAdminResult> => {
  await seedPlatformRoles(db);

  let userId = params.userId?.trim() || null;
  const adminUserModel = new AdminUserModel(db);
  const requestedEmail =
    params.email?.trim() || (params.allowCreate ? 'breakglass@localhost' : null);

  if (!userId && requestedEmail) {
    userId = await adminUserModel.findUserIdByEmail(requestedEmail);
  }

  if (!userId && params.allowCreate) {
    // Credential account is useless when email/password sign-in is disabled instance-wide.
    if (authEnv.AUTH_DISABLE_EMAIL_PASSWORD) {
      throw new Error(
        'Cannot create break-glass credential user while AUTH_DISABLE_EMAIL_PASSWORD is enabled',
      );
    }

    const id = `breakglass_${Date.now().toString(36)}`;
    const email = requestedEmail!;
    const normalizedEmail = email.toLowerCase();
    const username = params.username?.trim() || `breakglass`;
    // Password: preserve exact bytes (no trim). Empty/undefined → generate one-time secret.
    const suppliedPassword =
      typeof params.password === 'string' && params.password.length > 0 ? params.password : '';
    const password = suppliedPassword || generateOneTimePassword();
    assertBootstrapCredentialPassword(password);
    const oneTimePassword = suppliedPassword ? undefined : password;

    // Hash outside the transaction (scrypt is CPU-bound); write-only material.
    const passwordHash = await hashPassword(password);

    // Create user + Better Auth credential account + super_admin role atomically.
    // Do not set users.role='admin' — that unlocks Better Auth admin plugin bypasses.
    // Platform super_admin is granted solely via rbac_user_roles below.
    await db.transaction(async (tx) => {
      const model = new AdminUserModel(tx);
      await model.createCredentialUser({
        accountId: generateEntityId('acct_'),
        email,
        fullName: 'Break-glass Super Admin',
        normalizedEmail,
        passwordHash,
        userId: id,
        username,
      });
      await assignGlobalPlatformRole(tx, {
        roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
        userId: id,
      });
    });

    return {
      alreadySuperAdmin: false,
      credentialRepaired: false,
      createdUser: true,
      oneTimePassword,
      roleAssigned: true,
      userId: id,
    };
  }

  if (!userId) {
    throw new Error(
      'Bootstrap requires BOOTSTRAP_SUPER_ADMIN_USER_ID or BOOTSTRAP_SUPER_ADMIN_EMAIL (set BOOTSTRAP_ALLOW_CREATE=1 to create a local break-glass user)',
    );
  }

  const rbac = new RbacModel(db, userId);
  const alreadySuperAdmin = await rbac.isGlobalSuperAdmin(userId);

  // Role promotion is independent of auth provider. OIDC-only users normally have
  // no Better Auth `credential` account; they must still receive super_admin.
  // Credential repair is opt-in (legacy break-glass / local password recovery).
  const existingCredential = await db.query.account.findFirst({
    where: (t, { and, eq }) => and(eq(t.userId, userId), eq(t.providerId, 'credential')),
  });

  const needsRole = !alreadySuperAdmin;
  const wantsCredentialRepair = params.repairCredential === true;
  const needsCredential = wantsCredentialRepair && !existingCredential;

  let credentialRepaired = false;
  let oneTimePassword: string | undefined;
  let passwordHash: string | undefined;

  // Validate + hash BEFORE any privilege write so a failed repair cannot leave a
  // privileged but credentialless user while the command reports failure.
  if (needsCredential) {
    if (authEnv.AUTH_DISABLE_EMAIL_PASSWORD) {
      throw new Error(
        'Cannot repair break-glass credential while AUTH_DISABLE_EMAIL_PASSWORD is enabled',
      );
    }

    const suppliedPassword =
      typeof params.password === 'string' && params.password.length > 0 ? params.password : '';
    const password = suppliedPassword || generateOneTimePassword();
    assertBootstrapCredentialPassword(password);
    oneTimePassword = suppliedPassword ? undefined : password;
    // Hash outside the transaction (scrypt is CPU-bound); write-only material.
    passwordHash = await hashPassword(password);
  }

  if (needsRole || needsCredential) {
    // Role grant + optional credential insert are all-or-nothing when both apply.
    await db.transaction(async (tx) => {
      if (needsCredential && passwordHash) {
        await tx.insert(account).values({
          accountId: userId,
          createdAt: new Date(),
          id: generateEntityId('acct_'),
          password: passwordHash,
          providerId: 'credential',
          updatedAt: new Date(),
          userId,
        });
      }
      if (needsRole) {
        await assignGlobalPlatformRole(tx, {
          roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
          userId,
        });
      }
    });
    credentialRepaired = needsCredential;
  }

  return {
    alreadySuperAdmin,
    credentialRepaired,
    createdUser: false,
    oneTimePassword,
    roleAssigned: needsRole,
    userId,
  };
};

/**
 * Idempotent startup check: ensure platform roles exist; report super_admin count.
 * Does not auto-create admins.
 */
export const ensurePlatformRbacSeeded = async (
  db: LobeChatDatabase,
): Promise<{ superAdminCount: number }> => {
  await seedPlatformRoles(db);
  const rbac = new RbacModel(db, 'system');
  const superAdminCount = await rbac.countActiveSuperAdmins();
  return { superAdminCount };
};

// CLI entry when executed directly
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('superAdmin.ts') || process.argv[1].endsWith('superAdmin.js'));

if (isMain) {
  const run = async () => {
    const { getServerDB } = await import('@/database/core/db-adaptor');
    const db = await getServerDB();
    const result = await bootstrapSuperAdmin(db, {
      allowCreate: process.env.BOOTSTRAP_ALLOW_CREATE === '1',
      email: process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL,
      password: process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD,
      repairCredential: process.env.BOOTSTRAP_REPAIR_CREDENTIAL === '1',
      userId: process.env.BOOTSTRAP_SUPER_ADMIN_USER_ID,
      username: process.env.BOOTSTRAP_SUPER_ADMIN_USERNAME,
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ok: true,
        alreadySuperAdmin: result.alreadySuperAdmin,
        credentialRepaired: result.credentialRepaired,
        createdUser: result.createdUser,
        // Printed once when generated — store securely; never logged elsewhere.
        oneTimePassword: result.oneTimePassword,
        roleAssigned: result.roleAssigned,
        userId: result.userId,
      }),
    );
  };
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
