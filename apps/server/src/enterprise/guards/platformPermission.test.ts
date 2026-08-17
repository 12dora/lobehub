// @vitest-environment node
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, createCallerFactory, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { resetModuleSettingsForTest } from '../services/moduleSettings';
import { createAdminAuthorizationFixture } from '../testing/adminAuthorizationFixture';
import { getEnterpriseErrorBody } from './enterpriseErrors';
import { loadPlatformAuthContext, withPlatformPermission } from './platformPermission';

const db: LobeChatDatabase = await getTestDB();

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const testRouter = router({
  needsUserBan: authedProcedure
    .use(serverDatabase)
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .query(() => ({ ok: true })),
  alsoNeedsUserBan: authedProcedure
    .use(serverDatabase)
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_BAN))
    .query(() => ({ ok: true })),
  admin: router({
    audit: router({
      list: authedProcedure
        .use(serverDatabase)
        .use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ))
        .query(() => ({ ok: true })),
    }),
  }),
});

const createCaller = createCallerFactory(testRouter);
const fixture = createAdminAuthorizationFixture({ namespace: 'platform-permission' });

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await fixture.setup(db);
});

afterEach(async () => {
  await fixture.cleanup(db);
  resetModuleSettingsForTest();
  vi.unstubAllEnvs();
});

describe('withPlatformPermission', () => {
  it('allows when user has the global permission', async () => {
    const contexts = await fixture.createContexts(db);
    const caller = createCaller(contexts.userAdmin as never);
    await expect(caller.needsUserBan()).resolves.toEqual({ ok: true });
  });

  it('denies with structured PLATFORM_PERMISSION_DENIED', async () => {
    const contexts = await fixture.createContexts(db);
    const caller = createCaller(contexts.normal as never);
    try {
      await caller.needsUserBan();
      expect.fail('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('FORBIDDEN');
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_PERMISSION_DENIED,
      );
    }

    const deniedAudit = await db.query.platformAuditLogs.findFirst({
      where: and(
        eq(platformAuditLogs.action, 'admin.permission.denied'),
        eq(platformAuditLogs.actorUserId, fixture.actors.normal),
      ),
    });
    expect(deniedAudit).toMatchObject({
      actorUserId: fixture.actors.normal,
      result: 'denied',
      targetType: 'permission',
    });
  });

  it('feature flag off → ADMIN_FEATURE_DISABLED', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    const contexts = await fixture.createContexts(db);
    const caller = createCaller(contexts.superAdmin as never);
    await expect(caller.needsUserBan()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('disabled module → PLATFORM_MODULE_DISABLED (FORBIDDEN, data.moduleId)', async () => {
    vi.stubEnv('LOBE_MODULES_DISABLED', 'audit');
    const contexts = await fixture.createContexts(db);
    const caller = createCaller(contexts.superAdmin as never);
    try {
      await caller.admin.audit.list();
      expect.fail('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('FORBIDDEN');
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
      );
      expect(getEnterpriseErrorBody(error)?.details).toEqual({ moduleId: 'audit' });
    }
  });

  it('memoizes loadPlatformAuthContext per request ctx (one RBAC join)', async () => {
    const userId = fixture.actors.userAdmin;
    const scope = { resHeaders: new Headers() };

    const first = await loadPlatformAuthContext({ db, scope, userId });
    const second = await loadPlatformAuthContext({ db, scope, userId });
    expect(second).toBe(first);

    const other = await loadPlatformAuthContext({
      db,
      scope: { resHeaders: new Headers() },
      userId,
    });
    expect(other).not.toBe(first);
    expect(other).toEqual(first);
  });
});
