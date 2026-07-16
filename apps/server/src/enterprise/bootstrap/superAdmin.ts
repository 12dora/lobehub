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
 *   BOOTSTRAP_SUPER_ADMIN_USERNAME — username when creating
 *
 * Idempotent: re-running is safe. Never auto-promotes the first registered user.
 */
import { eq } from 'drizzle-orm';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { RbacModel } from '@/database/models/rbac';
import { users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';

export interface BootstrapSuperAdminResult {
  alreadySuperAdmin: boolean;
  createdUser: boolean;
  roleAssigned: boolean;
  userId: string;
}

export interface BootstrapSuperAdminParams {
  allowCreate?: boolean;
  email?: string | null;
  userId?: string | null;
  username?: string | null;
}

export const bootstrapSuperAdmin = async (
  db: LobeChatDatabase,
  params: BootstrapSuperAdminParams,
): Promise<BootstrapSuperAdminResult> => {
  await seedPlatformRoles(db);

  let userId = params.userId?.trim() || null;
  let createdUser = false;

  if (!userId && params.email) {
    const found = await db.query.users.findFirst({
      where: eq(users.email, params.email.trim()),
    });
    userId = found?.id ?? null;
  }

  if (!userId && params.allowCreate) {
    const id = `breakglass_${Date.now().toString(36)}`;
    const email = params.email?.trim() || `breakglass+${id}@localhost`;
    const username = params.username?.trim() || `breakglass`;
    await db.insert(users).values({
      email,
      emailVerified: true,
      fullName: 'Break-glass Super Admin',
      id,
      role: 'admin',
      username,
    });
    userId = id;
    createdUser = true;
  }

  if (!userId) {
    throw new Error(
      'Bootstrap requires BOOTSTRAP_SUPER_ADMIN_USER_ID or BOOTSTRAP_SUPER_ADMIN_EMAIL (set BOOTSTRAP_ALLOW_CREATE=1 to create a local break-glass user)',
    );
  }

  const rbac = new RbacModel(db, userId);
  const alreadySuperAdmin = await rbac.isGlobalSuperAdmin(userId);

  if (!alreadySuperAdmin) {
    await assignGlobalPlatformRole(db, {
      roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
      userId,
    });
  }

  return {
    alreadySuperAdmin,
    createdUser,
    roleAssigned: !alreadySuperAdmin,
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
      userId: process.env.BOOTSTRAP_SUPER_ADMIN_USER_ID,
      username: process.env.BOOTSTRAP_SUPER_ADMIN_USERNAME,
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ok: true,
        alreadySuperAdmin: result.alreadySuperAdmin,
        createdUser: result.createdUser,
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
