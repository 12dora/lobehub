// @vitest-environment node
/**
 * Real-Postgres concurrency tests for last-super invariants (M04 R1).
 * Run: cd packages/database && TEST_SERVER_DB=1 bunx vitest run src/models/__tests__/adminUser.concurrency.test.ts
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { getTestDB } from '../../core/getTestDB';
import { permissions, rolePermissions, roles, userRoles, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { seedPlatformRoles } from '../../utils/seedPlatformRoles';
import { AdminUserModel } from '../adminUser';
import { LastSuperAdminProtectionError, RbacModel } from '../rbac';

const hasServerDbUrl = Boolean(process.env.DATABASE_TEST_URL || process.env.DATABASE_URL);
const isServerDB = process.env.TEST_SERVER_DB === '1' && hasServerDbUrl;

describe.skipIf(!isServerDB)('M04 last-super concurrency (TEST_SERVER_DB=1)', () => {
  let db: LobeChatDatabase;
  const a = 'conc-super-a';
  const b = 'conc-super-b';

  const cleanup = async () => {
    if (!db) return;
    await db.delete(userRoles);
    await db.delete(rolePermissions);
    await db.delete(roles);
    await db.delete(permissions);
    await db.delete(users);
  };

  beforeEach(async () => {
    db = await getTestDB();
    await cleanup();
    await seedPlatformRoles(db);
    await db.insert(users).values([{ id: a }, { id: b }]);
    const role = await db.query.roles.findFirst({
      where: (t, { and, eq, isNull }) =>
        and(eq(t.name, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN), isNull(t.workspaceId)),
    });
    await db.insert(userRoles).values([
      { roleId: role!.id, userId: a, workspaceId: null },
      { roleId: role!.id, userId: b, workspaceId: null },
    ]);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('concurrent demotions cannot clear all permanent supers', async () => {
    const rbacA = new RbacModel(db, a);
    const rbacB = new RbacModel(db, b);

    const results = await Promise.allSettled([
      rbacA.replaceGlobalUserRoles(a, []),
      rbacB.replaceGlobalUserRoles(b, []),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeLessThan(2);

    const count = await new RbacModel(db, 'system').countActiveSuperAdmins();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('concurrent ban of last two supers leaves ≥1 active', async () => {
    const banOne = async (userId: string) => {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM rbac_roles WHERE name = ${PLATFORM_SYSTEM_ROLES.SUPER_ADMIN} AND workspace_id IS NULL FOR UPDATE`,
        );
        const r = new RbacModel(tx as LobeChatDatabase, userId);
        if (await r.isGlobalSuperAdmin(userId)) {
          const c = await r.countActiveSuperAdmins();
          if (c <= 1) throw new LastSuperAdminProtectionError();
        }
        const m = new AdminUserModel(tx);
        await m.setBanned({ banReason: 'race', banned: true, userId });
      });
    };

    const results = await Promise.allSettled([banOne(a), banOne(b)]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeLessThan(2);
    expect(await new RbacModel(db, 'system').countActiveSuperAdmins()).toBeGreaterThanOrEqual(1);
  });
});
