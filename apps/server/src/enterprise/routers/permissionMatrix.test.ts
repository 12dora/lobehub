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
import { isAuthorizedByPlatformPermissions } from '../security/policy/adminProcedureAuthorization/reconcile';
import { ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY } from '../security/policy/adminProcedureAuthorizationRegistry';
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
  'admin.system.getInfraSettings',
  'admin.system.getInstanceRevisions',
  'admin.system.getJobs',
  'admin.system.getStatus',
  'admin.system.retryJob',
  'admin.system.testDependency',
  'admin.system.updateInfraSettings',
] as const;
const o04SystemProcedurePathSet = new Set<string>(o04SystemProcedurePaths);
const o04SystemReadProcedurePaths = [
  'admin.system.getInfraSettings',
  'admin.system.getInstanceRevisions',
  'admin.system.getJobs',
  'admin.system.getStatus',
] as const;

/**
 * Explicit named permission package per matrix role.
 * This is the intentional contract the matrix pins — must stay aligned with
 * `PLATFORM_ROLE_PERMISSIONS`. Procedure package sizes are then *derived* from
 * this set + the authorization registry so a permission change cannot leave a
 * stale hardcoded procedure count behind.
 *
 * Super-admin is omitted: it is "all platform permissions" by construction.
 */
const MATRIX_ROLE_PERMISSIONS = {
  [PLATFORM_SYSTEM_ROLES.AI_ADMIN]: [
    PLATFORM_PERMISSIONS.ADMIN_ACCESS,
    PLATFORM_PERMISSIONS.USER_READ,
    PLATFORM_PERMISSIONS.SETTINGS_READ,
    PLATFORM_PERMISSIONS.POLICY_READ,
    PLATFORM_PERMISSIONS.POLICY_UPDATE,
    PLATFORM_PERMISSIONS.POLICY_PUBLISH,
    PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
    PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE,
    PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
    PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE,
    PLATFORM_PERMISSIONS.AI_PROVIDER_TEST,
    PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
    PLATFORM_PERMISSIONS.AI_MODEL_READ,
    PLATFORM_PERMISSIONS.AI_MODEL_CREATE,
    PLATFORM_PERMISSIONS.AI_MODEL_UPDATE,
    PLATFORM_PERMISSIONS.AI_MODEL_DELETE,
    PLATFORM_PERMISSIONS.AI_MODEL_PUBLISH,
    PLATFORM_PERMISSIONS.SKILL_READ,
    PLATFORM_PERMISSIONS.SKILL_CREATE,
    PLATFORM_PERMISSIONS.SKILL_UPDATE,
    PLATFORM_PERMISSIONS.SKILL_DELETE,
    PLATFORM_PERMISSIONS.SKILL_PUBLISH,
    PLATFORM_PERMISSIONS.CONNECTOR_READ,
    PLATFORM_PERMISSIONS.CONNECTOR_CREATE,
    PLATFORM_PERMISSIONS.CONNECTOR_UPDATE,
    PLATFORM_PERMISSIONS.CONNECTOR_DELETE,
    PLATFORM_PERMISSIONS.CONNECTOR_TEST,
    PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH,
    PLATFORM_PERMISSIONS.AGENT_READ,
    PLATFORM_PERMISSIONS.AGENT_CREATE,
    PLATFORM_PERMISSIONS.AGENT_UPDATE,
    PLATFORM_PERMISSIONS.AGENT_DELETE,
    PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    PLATFORM_PERMISSIONS.AGENT_ASSIGN,
    PLATFORM_PERMISSIONS.CRED_READ,
    PLATFORM_PERMISSIONS.CRED_CREATE,
    PLATFORM_PERMISSIONS.CRED_UPDATE,
    PLATFORM_PERMISSIONS.CRED_DELETE,
    PLATFORM_PERMISSIONS.AUDIT_READ,
    PLATFORM_PERMISSIONS.MODERATION_READ,
    PLATFORM_PERMISSIONS.MODERATION_MANAGE,
  ],
  // Hand-written pin — do NOT derive from :read:/:export: filters. A derived pin would
  // equal production by construction and miss the drift class that made auditor stale
  // (76 vs 74). Adding any new read/export permission must fail this list and force a
  // deliberate decision about auditor's reach.
  [PLATFORM_SYSTEM_ROLES.AUDITOR]: [
    PLATFORM_PERMISSIONS.ADMIN_ACCESS,
    PLATFORM_PERMISSIONS.USER_READ,
    PLATFORM_PERMISSIONS.SETTINGS_READ,
    PLATFORM_PERMISSIONS.POLICY_READ,
    PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
    PLATFORM_PERMISSIONS.AI_MODEL_READ,
    PLATFORM_PERMISSIONS.SKILL_READ,
    PLATFORM_PERMISSIONS.CONNECTOR_READ,
    PLATFORM_PERMISSIONS.AGENT_READ,
    PLATFORM_PERMISSIONS.IDENTITY_READ,
    PLATFORM_PERMISSIONS.BRANDING_READ,
    PLATFORM_PERMISSIONS.AUDIT_READ,
    PLATFORM_PERMISSIONS.AUDIT_EXPORT,
    PLATFORM_PERMISSIONS.SYSTEM_READ,
    PLATFORM_PERMISSIONS.STATS_READ,
    PLATFORM_PERMISSIONS.CRED_READ,
    PLATFORM_PERMISSIONS.ROLE_READ,
    PLATFORM_PERMISSIONS.MODERATION_READ,
    PLATFORM_PERMISSIONS.NETWORK_PROXY_READ,
  ],
  [PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN]: [
    PLATFORM_PERMISSIONS.ADMIN_ACCESS,
    PLATFORM_PERMISSIONS.USER_READ,
    PLATFORM_PERMISSIONS.IDENTITY_READ,
    PLATFORM_PERMISSIONS.IDENTITY_CREATE,
    PLATFORM_PERMISSIONS.IDENTITY_UPDATE,
    PLATFORM_PERMISSIONS.IDENTITY_DELETE,
    PLATFORM_PERMISSIONS.IDENTITY_TEST,
    PLATFORM_PERMISSIONS.IDENTITY_PUBLISH,
    PLATFORM_PERMISSIONS.OIDC_PUBLISH,
    PLATFORM_PERMISSIONS.BRANDING_READ,
    PLATFORM_PERMISSIONS.BRANDING_UPDATE,
    PLATFORM_PERMISSIONS.BRANDING_PUBLISH,
    PLATFORM_PERMISSIONS.AUDIT_READ,
  ],
  [PLATFORM_SYSTEM_ROLES.PLATFORM_USER]: [] as const satisfies readonly PlatformPermission[],
  [PLATFORM_SYSTEM_ROLES.USER_ADMIN]: [
    PLATFORM_PERMISSIONS.ADMIN_ACCESS,
    PLATFORM_PERMISSIONS.USER_READ,
    PLATFORM_PERMISSIONS.USER_CREATE,
    PLATFORM_PERMISSIONS.USER_BAN,
    PLATFORM_PERMISSIONS.USER_DELETE,
    PLATFORM_PERMISSIONS.USER_SESSION_REVOKE,
    PLATFORM_PERMISSIONS.USER_ROLE_MANAGE,
    PLATFORM_PERMISSIONS.ROLE_READ,
    PLATFORM_PERMISSIONS.ROLE_UPDATE,
    PLATFORM_PERMISSIONS.AUDIT_READ,
  ],
} as const satisfies Record<
  Exclude<
    (typeof PLATFORM_SYSTEM_ROLES)[keyof typeof PLATFORM_SYSTEM_ROLES],
    typeof PLATFORM_SYSTEM_ROLES.SUPER_ADMIN
  >,
  readonly PlatformPermission[]
>;

const authorizedProceduresForPermissions = (permissions: ReadonlySet<PlatformPermission>) =>
  ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter((authorization) =>
    isAuthorizedByPlatformPermissions(authorization, permissions),
  );

const roleCases = [
  {
    expectedO04SystemPaths: o04SystemProcedurePaths,
    role: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
  },
  {
    expectedO04SystemPaths: [] as const,
    role: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
  },
  {
    expectedO04SystemPaths: o04SystemReadProcedurePaths,
    role: PLATFORM_SYSTEM_ROLES.AUDITOR,
  },
  {
    expectedO04SystemPaths: [] as const,
    role: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
  },
  {
    expectedO04SystemPaths: [] as const,
    role: PLATFORM_SYSTEM_ROLES.USER_ADMIN,
  },
  {
    expectedO04SystemPaths: [] as const,
    role: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
  },
] as const;

// PGlite applies the full migration baseline on first getTestDB() — allow headroom.
beforeAll(async () => {
  db = await getTestDB();
}, 120_000);

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

  for (const { expectedO04SystemPaths, role } of roleCases) {
    it(`${role} authorizes the procedure package derived from its permission package`, () => {
      // Pin: production role package must match the explicit matrix contract (non-super).
      if (role !== PLATFORM_SYSTEM_ROLES.SUPER_ADMIN) {
        expect([...PLATFORM_ROLE_PERMISSIONS[role]].sort()).toEqual(
          [...MATRIX_ROLE_PERMISSIONS[role]].sort(),
        );
      }

      const permissions = new Set<PlatformPermission>(PLATFORM_ROLE_PERMISSIONS[role]);
      // Derive procedure package from the permission set + registry (no hardcoded counts).
      const allowed = authorizedProceduresForPermissions(permissions);
      const allowedO04SystemPaths = allowed
        .map(({ path }) => path)
        .filter((path) => o04SystemProcedurePathSet.has(path));

      expect(allowedO04SystemPaths).toEqual([...expectedO04SystemPaths]);

      if (role === PLATFORM_SYSTEM_ROLES.SUPER_ADMIN) {
        expect(allowed).toHaveLength(ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.length);
      } else if (role === PLATFORM_SYSTEM_ROLES.PLATFORM_USER) {
        // Platform users only get the self-access surface (no platform permissions).
        expect(allowed).toEqual([
          { kind: 'query', path: 'admin.auth.getMyAccess', selfAccess: true },
        ]);
      } else {
        // Floor only: procedure package is derived from the pinned permission set so
        // hardcoding path lists here would go stale with every registry edit.
        // Per-role procedure-reachability drift is guarded by
        // security/policy/adminProcedureAuthorizationRegistry.test.ts (registry length
        // pin + fails on permission-changed declarations) — do not assume this file
        // still covers exact package size.
        expect(allowed.length).toBeGreaterThan(1);
        // user_admin must not regain platform_user:update:all (intentionally removed).
        if (role === PLATFORM_SYSTEM_ROLES.USER_ADMIN) {
          expect([...permissions]).not.toContain('platform_user:update:all');
        }
      }
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
