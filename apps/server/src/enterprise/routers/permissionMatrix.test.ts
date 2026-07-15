/**
 * Permission matrix tests (docs/redevelopment/list/04_权限矩阵.md).
 * Every role × representative admin surface × expected allow/deny.
 *
 * @vitest-environment node
 */
import { WORKSPACE_SYSTEM_ROLES } from '@lobechat/const/rbac';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
  workspaces,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { seedWorkspaceRoles } from '@/database/utils/seedWorkspaceRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { getEnterpriseErrorBody } from '../guards/enterpriseErrors';
import { adminRouter } from './admin';

let db: LobeChatDatabase;

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const createAdminCaller = createCallerFactory(adminRouter);

const IDS = {
  aiAdmin: 'matrix-ai-admin',
  anonymous: null as null,
  auditor: 'matrix-auditor',
  identityAdmin: 'matrix-identity-admin',
  normal: 'matrix-normal-user',
  superAdmin: 'matrix-super-admin',
  userAdmin: 'matrix-user-admin',
  workspaceOwner: 'matrix-ws-owner',
};

const workspaceId = 'matrix-ws';

const cleanup = async () => {
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(workspaces);
  await db.delete(users);
};

const grantGlobalRole = async (userId: string, roleName: string) => {
  const role = await db.query.roles.findFirst({
    where: (t, { and, eq, isNull }) => and(eq(t.name, roleName), isNull(t.workspaceId)),
  });
  if (!role) throw new Error(`role ${roleName} missing`);
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeAll(async () => {
  db = await getTestDB();
});

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
  await db.insert(users).values(
    Object.values(IDS)
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id })),
  );
  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'Matrix WS',
    primaryOwnerId: IDS.workspaceOwner,
    slug: 'matrix-ws',
  });
  await seedWorkspaceRoles(db, workspaceId);
  await seedPlatformRoles(db);

  await grantGlobalRole(IDS.superAdmin, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  await grantGlobalRole(IDS.userAdmin, PLATFORM_SYSTEM_ROLES.USER_ADMIN);
  await grantGlobalRole(IDS.aiAdmin, PLATFORM_SYSTEM_ROLES.AI_ADMIN);
  await grantGlobalRole(IDS.identityAdmin, PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN);
  await grantGlobalRole(IDS.auditor, PLATFORM_SYSTEM_ROLES.AUDITOR);
  // Base aihub.access for non-admin principals so matrix asserts PLATFORM_PERMISSION_DENIED
  // (not ACCESS_NOT_GRANTED) on admin APIs.
  await grantGlobalRole(IDS.normal, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);
  await grantGlobalRole(IDS.workspaceOwner, PLATFORM_SYSTEM_ROLES.PLATFORM_USER);

  // workspace owner only
  const { RbacModel } = await import('@/database/models/rbac');
  const rbac = new RbacModel(db, IDS.workspaceOwner);
  await rbac.assignWorkspaceRole({
    roleName: WORKSPACE_SYSTEM_ROLES.OWNER,
    userId: IDS.workspaceOwner,
    workspaceId,
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

/** Patch serverDatabase middleware by providing serverDB on context via createCaller. */
const withDbCtx = async (userId?: string) => {
  const base = await createContextInner(userId ? { userId } : {});
  return { ...base, serverDB: db } as never;
};

describe('permission matrix (list/04)', () => {
  describe('anonymous → UNAUTHORIZED', () => {
    it('admin.auth.getMyAccess rejects anonymous', async () => {
      const caller = createAdminCaller(await withDbCtx());
      await expect(caller.auth.getMyAccess()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('admin.roles.listSystemRoles rejects anonymous', async () => {
      const caller = createAdminCaller(await withDbCtx());
      await expect(caller.roles.listSystemRoles()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('workspace_owner / normal user → FORBIDDEN on admin APIs', () => {
    for (const [label, userId] of [
      ['workspace_owner', IDS.workspaceOwner],
      ['normal_user', IDS.normal],
    ] as const) {
      it(`${label} cannot list system roles`, async () => {
        expect.assertions(2);
        const caller = createAdminCaller(await withDbCtx(userId));
        await expect(caller.roles.listSystemRoles()).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        try {
          await caller.roles.listSystemRoles();
        } catch (error) {
          const body = getEnterpriseErrorBody(error);
          expect(body?.code).toBe(PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED);
        }
      });

      it(`${label} cannot list audit logs`, async () => {
        const caller = createAdminCaller(await withDbCtx(userId));
        await expect(caller.audit.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      });

      it(`${label} cannot trigger easyauth sync`, async () => {
        const caller = createAdminCaller(await withDbCtx(userId));
        await expect(
          caller.easyauth.triggerSync({ reason: 'test', userId: IDS.normal }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      });
    }
  });

  describe('super_admin → allow all matrix surfaces', () => {
    it('can list roles, audit, and getMyAccess with full permissions', async () => {
      const caller = createAdminCaller(await withDbCtx(IDS.superAdmin));
      const access = await caller.auth.getMyAccess();
      expect(access.hasAdminAccess).toBe(true);
      expect(access.permissions).toContain(PLATFORM_PERMISSIONS.USER_BAN);
      expect(access.permissions).toContain(PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE);

      await expect(caller.roles.listSystemRoles()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN }),
        ]),
      );
      await expect(caller.audit.list({ limit: 5 })).resolves.toMatchObject({
        items: expect.any(Array),
      });
    });
  });

  describe('user_admin', () => {
    it('can manage roles but getMyAccess lacks AI create', async () => {
      const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
      const access = await caller.auth.getMyAccess();
      expect(access.hasAdminAccess).toBe(true);
      expect(access.permissions).toContain(PLATFORM_PERMISSIONS.USER_BAN);
      expect(access.permissions).toContain(PLATFORM_PERMISSIONS.ROLE_UPDATE);
      expect(access.permissions).not.toContain(PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE);

      await expect(caller.roles.listSystemRoles()).resolves.toBeTruthy();
      // audit read is allowed for user_admin
      await expect(caller.audit.list({ limit: 1 })).resolves.toBeTruthy();
    });

    it('cannot demote super_admin (matrix hard gate)', async () => {
      expect.assertions(2);
      const caller = createAdminCaller(await withDbCtx(IDS.userAdmin));
      // second super so last-super is not the only reason
      await grantGlobalRole(IDS.normal, PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
      try {
        await caller.roles.replaceUserGlobalRoles({
          reason: 'demote super',
          roleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
          userId: IDS.superAdmin,
        });
      } catch (error) {
        expect((error as { code: string }).code).toBe('FORBIDDEN');
        expect(getEnterpriseErrorBody(error)?.code).toBe(
          PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
        );
      }
    });
  });

  describe('ai_admin', () => {
    it('has AI permissions, cannot replace roles (no ROLE_UPDATE)', async () => {
      const caller = createAdminCaller(await withDbCtx(IDS.aiAdmin));
      const access = await caller.auth.getMyAccess();
      expect(access.permissions).toContain(PLATFORM_PERMISSIONS.AI_MODEL_PUBLISH);
      expect(access.permissions).not.toContain(PLATFORM_PERMISSIONS.USER_BAN);
      expect(access.permissions).not.toContain(PLATFORM_PERMISSIONS.ROLE_UPDATE);
      expect(access.permissions).not.toContain(PLATFORM_PERMISSIONS.SETTINGS_UPDATE);

      await expect(
        caller.roles.replaceUserGlobalRoles({
          reason: 'test',
          roleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
          userId: IDS.normal,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('identity_admin', () => {
    it('has identity permissions, not user ban', async () => {
      const caller = createAdminCaller(await withDbCtx(IDS.identityAdmin));
      const access = await caller.auth.getMyAccess();
      expect(access.permissions).toContain(PLATFORM_PERMISSIONS.IDENTITY_PUBLISH);
      expect(access.permissions).toContain(PLATFORM_PERMISSIONS.BRANDING_UPDATE);
      expect(access.permissions).not.toContain(PLATFORM_PERMISSIONS.USER_BAN);
      expect(access.permissions).not.toContain(PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE);
    });

    it('cannot list system roles without ROLE_READ package', async () => {
      // identity_admin package does not include ROLE_READ
      const caller = createAdminCaller(await withDbCtx(IDS.identityAdmin));
      await expect(caller.roles.listSystemRoles()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('auditor', () => {
    it('read-only: can list audit, cannot replace roles', async () => {
      const caller = createAdminCaller(await withDbCtx(IDS.auditor));
      const access = await caller.auth.getMyAccess();
      expect(access.permissions).toContain(PLATFORM_PERMISSIONS.AUDIT_EXPORT);
      expect(access.permissions).toContain(PLATFORM_PERMISSIONS.USER_READ);
      expect(access.permissions).not.toContain(PLATFORM_PERMISSIONS.USER_BAN);
      expect(access.permissions).not.toContain(PLATFORM_PERMISSIONS.ROLE_UPDATE);

      await expect(caller.audit.list({ limit: 1 })).resolves.toBeTruthy();
      await expect(
        caller.roles.replaceUserGlobalRoles({
          reason: 'test',
          roleNames: [],
          userId: IDS.normal,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('flag off → ADMIN_FEATURE_DISABLED', () => {
    it('denies admin roles when ENABLE_PLATFORM_ADMIN is off', async () => {
      expect.assertions(2);
      vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
      const caller = createAdminCaller(await withDbCtx(IDS.superAdmin));
      try {
        await caller.roles.listSystemRoles();
      } catch (error) {
        expect((error as { code: string }).code).toBe('FORBIDDEN');
        expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED);
      }
    });
  });

  describe('last super admin protection', () => {
    it('refuses to demote the only super_admin', async () => {
      const caller = createAdminCaller(await withDbCtx(IDS.superAdmin));
      await expect(
        caller.roles.replaceUserGlobalRoles({
          reason: 'demote',
          roleNames: [PLATFORM_SYSTEM_ROLES.AUDITOR],
          userId: IDS.superAdmin,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });
  });
});
