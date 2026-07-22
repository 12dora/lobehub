/**
 * Exhaustive role × admin procedure authorization matrix.
 * No business resolver is invoked: registry reconciliation separately proves these permission
 * facts came from the final procedure middleware chains.
 *
 * @vitest-environment node
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS, type PlatformPermission } from '@/const/platform/permissions';
import { PLATFORM_ROLE_PERMISSIONS, PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs, userRoles, users, workspaces } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, createCallerFactory, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { withActiveUser } from '../guards/activeUser';
import { getEnterpriseErrorBody } from '../guards/enterpriseErrors';
import {
  assertPlatformPermission,
  loadPlatformAuthContext,
  withPlatformPermission,
} from '../guards/platformPermission';
import {
  ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY,
  isAuthorizedByPlatformPermissions,
} from '../security/policy/adminProcedureAuthorizationRegistry';
import { createAdminAuthorizationFixture } from '../testing/adminAuthorizationFixture';

let db: LobeChatDatabase;

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const authorizationProbeRouter = router({
  selfAccess: authedProcedure
    .use(serverDatabase)
    .use(withActiveUser())
    .query(() => ({ ok: true })),
  userBan: authedProcedure
    .use(serverDatabase)
    .use(withActiveUser())
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .query(() => ({ ok: true })),
});
const createProbeCaller = createCallerFactory(authorizationProbeRouter);
const fixture = createAdminAuthorizationFixture({ namespace: 'permission-matrix' });

const o04SystemProcedurePaths = [
  'admin.system.cancelJob',
  'admin.system.getInstanceRevisions',
  'admin.system.getJobs',
  'admin.system.getStatus',
  'admin.system.retryJob',
] as const;
const o04SystemProcedurePathSet = new Set<string>(o04SystemProcedurePaths);
const o04SystemReadProcedurePaths = [
  'admin.system.getInstanceRevisions',
  'admin.system.getJobs',
  'admin.system.getStatus',
] as const;

const roleCases = [
  {
    expectedBeforeO04System: null,
    expectedO04SystemPaths: o04SystemProcedurePaths,
    role: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
  },
  {
    // Recount after W10 (creds/applyImmediate procedures) + admin.skills.parseImportSource = 96
    expectedBeforeO04System: 96,
    expectedO04SystemPaths: [],
    role: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
  },
  {
    // Recount after W10: creds reads (5) + easyauth status (1) + stats reads (12) = 57
    expectedBeforeO04System: 57,
    expectedO04SystemPaths: o04SystemReadProcedurePaths,
    role: PLATFORM_SYSTEM_ROLES.AUDITOR,
  },
  {
    // Recount after admin.easyauth.getStatus = 28
    expectedBeforeO04System: 28,
    expectedO04SystemPaths: [],
    role: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
  },
  {
    expectedBeforeO04System: 15,
    expectedO04SystemPaths: [],
    role: PLATFORM_SYSTEM_ROLES.USER_ADMIN,
  },
  {
    expectedBeforeO04System: 1,
    expectedO04SystemPaths: [],
    role: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
  },
] as const;

beforeAll(async () => {
  db = await getTestDB();
});

describe('admin authorization fixture isolation', () => {
  it('keeps concurrent fixtures isolated on the same database', async () => {
    const fixtureA = createAdminAuthorizationFixture({ namespace: 'parallel-a' });
    const fixtureB = createAdminAuthorizationFixture({ namespace: 'parallel-b' });

    expect(fixtureA.namespace).not.toBe(fixtureB.namespace);
    expect(fixtureA.namespace).toMatch(/^admin-auth-parallel-a-[\da-f]{32}$/);
    expect(Math.max(...Object.values(fixtureA.actors).map((id) => id.length))).toBeLessThanOrEqual(
      100,
    );
    expect(fixtureA.workspaceId.length).toBeLessThanOrEqual(100);
    await Promise.all([fixtureA.setup(db), fixtureB.setup(db)]);

    try {
      await db.insert(platformAuditLogs).values([
        {
          action: 'test.admin-authorization.denied',
          actorUserId: fixtureA.actors.normal,
          result: 'denied',
          targetType: 'permission',
        },
        {
          action: 'test.admin-authorization.denied',
          actorUserId: fixtureB.actors.normal,
          result: 'denied',
          targetType: 'permission',
        },
      ]);

      await fixtureA.cleanup(db);

      const [actorA, auditA, actorB, auditB, workspaceB, workspaceBindingB] = await Promise.all([
        db.query.users.findFirst({ where: eq(users.id, fixtureA.actors.normal) }),
        db.query.platformAuditLogs.findFirst({
          where: eq(platformAuditLogs.actorUserId, fixtureA.actors.normal),
        }),
        db.query.users.findFirst({ where: eq(users.id, fixtureB.actors.normal) }),
        db.query.platformAuditLogs.findFirst({
          where: eq(platformAuditLogs.actorUserId, fixtureB.actors.normal),
        }),
        db.query.workspaces.findFirst({ where: eq(workspaces.id, fixtureB.workspaceId) }),
        db.query.userRoles.findFirst({
          where: and(
            eq(userRoles.userId, fixtureB.actors.workspaceOwner),
            eq(userRoles.workspaceId, fixtureB.workspaceId),
          ),
        }),
      ]);
      expect({ actorA, auditA }).toEqual({ actorA: undefined, auditA: undefined });
      expect(actorB?.id).toBe(fixtureB.actors.normal);
      expect(auditB?.actorUserId).toBe(fixtureB.actors.normal);
      expect(workspaceB?.id).toBe(fixtureB.workspaceId);
      expect(workspaceBindingB?.userId).toBe(fixtureB.actors.workspaceOwner);

      const authB = await loadPlatformAuthContext({
        db,
        userId: fixtureB.actors.userAdmin,
      });
      expect(() => assertPlatformPermission(authB, PLATFORM_PERMISSIONS.USER_BAN)).not.toThrow();
    } finally {
      await fixtureA.cleanup(db);
      await fixtureB.cleanup(db);
    }

    const [actorB, auditB, workspaceB] = await Promise.all([
      db.query.users.findFirst({ where: eq(users.id, fixtureB.actors.normal) }),
      db.query.platformAuditLogs.findFirst({
        where: eq(platformAuditLogs.actorUserId, fixtureB.actors.normal),
      }),
      db.query.workspaces.findFirst({ where: eq(workspaces.id, fixtureB.workspaceId) }),
    ]);
    expect({ actorB, auditB, workspaceB }).toEqual({
      actorB: undefined,
      auditB: undefined,
      workspaceB: undefined,
    });
  });
});

describe('admin permission matrix', () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    await fixture.setup(db);
  });

  afterEach(async () => {
    await fixture.cleanup(db);
    vi.unstubAllEnvs();
  });

  for (const { expectedBeforeO04System, expectedO04SystemPaths, role } of roleCases) {
    it(`${role} authorizes the declared procedure package`, () => {
      const permissions = new Set(PLATFORM_ROLE_PERMISSIONS[role]);
      const allowed = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter((authorization) =>
        isAuthorizedByPlatformPermissions(authorization, permissions),
      );
      const allowedO04SystemPaths = allowed
        .map(({ path }) => path)
        .filter((path) => o04SystemProcedurePathSet.has(path));

      expect(allowedO04SystemPaths).toEqual(expectedO04SystemPaths);
      expect(allowed).toHaveLength(
        expectedBeforeO04System === null
          ? ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.length
          : expectedBeforeO04System + expectedO04SystemPaths.length,
      );
    });
  }

  it('seeds every fixture role with the same global permission package used by the matrix', async () => {
    const contextByRole = {
      [PLATFORM_SYSTEM_ROLES.AI_ADMIN]: 'aiAdmin',
      [PLATFORM_SYSTEM_ROLES.AUDITOR]: 'auditor',
      [PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN]: 'identityAdmin',
      [PLATFORM_SYSTEM_ROLES.PLATFORM_USER]: 'normal',
      [PLATFORM_SYSTEM_ROLES.SUPER_ADMIN]: 'superAdmin',
      [PLATFORM_SYSTEM_ROLES.USER_ADMIN]: 'userAdmin',
    } as const;

    const contexts = await fixture.createContexts(db);
    for (const { role } of roleCases) {
      const userId = contexts[contextByRole[role]].userId!;
      const auth = await loadPlatformAuthContext({ db, userId });
      expect(auth.permissions.sort()).toEqual([...PLATFORM_ROLE_PERMISSIONS[role]].sort());
    }
  });

  it('workspace owner stays platform-isolated and has only the self-access procedure', async () => {
    const workspaceOnlyPermissions = new Set<PlatformPermission>();
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter((authorization) =>
        isAuthorizedByPlatformPermissions(authorization, workspaceOnlyPermissions),
      ),
    ).toEqual([{ kind: 'query', path: 'admin.auth.getMyAccess', selfAccess: true }]);

    const contexts = await fixture.createContexts(db);
    const caller = createProbeCaller(contexts.workspaceOwner as never);

    await expect(caller.selfAccess()).resolves.toEqual({ ok: true });
    await expect(caller.userBan()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    try {
      await caller.userBan();
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      );
    }
  });

  it('normal user has only self access; super admin passes the pure permission probe', async () => {
    const contexts = await fixture.createContexts(db);

    await expect(createProbeCaller(contexts.normal as never).selfAccess()).resolves.toEqual({
      ok: true,
    });
    await expect(createProbeCaller(contexts.normal as never).userBan()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(createProbeCaller(contexts.superAdmin as never).userBan()).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects anonymous and flag-off callers before the probe resolver', async () => {
    expect.assertions(3);
    const contexts = await fixture.createContexts(db);
    await expect(createProbeCaller(contexts.anonymous as never).selfAccess()).rejects.toMatchObject(
      {
        code: 'UNAUTHORIZED',
      },
    );

    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    try {
      await createProbeCaller(contexts.superAdmin as never).userBan();
      expect.fail('flag-off permission probe must reject');
    } catch (error) {
      expect((error as { code: string }).code).toBe('FORBIDDEN');
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_FEATURE_DISABLED);
    }
  });

  it('provides reusable API-key and stale-reauth super contexts without claiming reauth coverage', async () => {
    const contexts = await fixture.createContexts(db);

    expect(contexts.apiKeySuper.authMethod).toBe('api-key');
    expect(contexts.apiKeySuper.authenticatedAt).toBeNull();
    expect(contexts.staleReauthSuper.authMethod).toBe('better-auth');
    expect(contexts.staleReauthSuper.authenticatedAt!.getTime()).toBeLessThan(
      Date.now() - 60 * 60 * 1000,
    );
    await expect(createProbeCaller(contexts.apiKeySuper as never).userBan()).resolves.toEqual({
      ok: true,
    });
    await expect(createProbeCaller(contexts.staleReauthSuper as never).userBan()).resolves.toEqual({
      ok: true,
    });
  });
});
