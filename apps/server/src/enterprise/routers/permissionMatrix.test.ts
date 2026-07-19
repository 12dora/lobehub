/**
 * Exhaustive role × admin procedure authorization matrix.
 * No business resolver is invoked: registry reconciliation separately proves these permission
 * facts came from the final procedure middleware chains.
 *
 * @vitest-environment node
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES, PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS, type PlatformPermission } from '@/const/platform/permissions';
import { PLATFORM_ROLE_PERMISSIONS, PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, createCallerFactory, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { withActiveUser } from '../guards/activeUser';
import { getEnterpriseErrorBody } from '../guards/enterpriseErrors';
import { loadPlatformAuthContext, withPlatformPermission } from '../guards/platformPermission';
import {
  ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY,
  isAuthorizedByPlatformPermissions,
} from '../security/policy/adminProcedureAuthorizationRegistry';
import {
  cleanupAdminAuthorizationFixture,
  createAdminAuthorizationContexts,
  setupAdminAuthorizationFixture,
} from '../testing/adminAuthorizationFixture';

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

const roleCases = [
  { expected: 109, role: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN },
  { expected: 76, role: PLATFORM_SYSTEM_ROLES.AI_ADMIN },
  { expected: 37, role: PLATFORM_SYSTEM_ROLES.AUDITOR },
  { expected: 27, role: PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN },
  { expected: 15, role: PLATFORM_SYSTEM_ROLES.USER_ADMIN },
  { expected: 1, role: PLATFORM_SYSTEM_ROLES.PLATFORM_USER },
] as const;

beforeAll(async () => {
  db = await getTestDB();
});

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await setupAdminAuthorizationFixture(db);
});

afterEach(async () => {
  await cleanupAdminAuthorizationFixture(db);
  vi.unstubAllEnvs();
});

describe('admin permission matrix', () => {
  for (const { expected, role } of roleCases) {
    it(`${role} authorizes exactly ${expected} of 109 procedures`, () => {
      const permissions = new Set(PLATFORM_ROLE_PERMISSIONS[role]);
      const allowed = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter((authorization) =>
        isAuthorizedByPlatformPermissions(authorization, permissions),
      );
      expect(allowed).toHaveLength(expected);
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

    const contexts = await createAdminAuthorizationContexts(db);
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

    const contexts = await createAdminAuthorizationContexts(db);
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
    const contexts = await createAdminAuthorizationContexts(db);

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
    const contexts = await createAdminAuthorizationContexts(db);
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
    const contexts = await createAdminAuthorizationContexts(db);

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
