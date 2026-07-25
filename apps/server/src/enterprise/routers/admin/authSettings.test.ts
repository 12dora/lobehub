// @vitest-environment node
/**
 * admin.authSettings — audit atomicity + permission contract + shared schema wiring.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformAuthSettings,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(adminRouter);
const createCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).authSettings;

const ids = {
  admin: 'auth-settings-admin',
  /** Auditor has IDENTITY_READ (and other :read:) but not IDENTITY_UPDATE. */
  reader: 'auth-settings-reader',
};

const appendSpy = vi.hoisted(() => vi.fn());

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('../../services/platformAudit', () => ({
  PlatformAuditService: class {
    append = appendSpy;
  },
}));

const cleanup = async () => {
  // Audit logs are append-only (row triggers); TRUNCATE is the test cleanup path.
  await db.execute(sql.raw('TRUNCATE TABLE platform_audit_logs CASCADE'));
  await db.delete(platformAuthSettings);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  appendSpy.mockReset();
  appendSpy.mockImplementation(async (params: { action: string }) => ({
    action: params.action,
    id: 'audit-ok',
    result: 'success',
  }));
  await cleanup();
  await db.insert(users).values([{ id: ids.admin }, { id: ids.reader }]);
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
    userId: ids.admin,
  });
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AUDITOR,
    userId: ids.reader,
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (userId: string = ids.admin) =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId,
    })),
    serverDB: db,
  } as never);

describe('authSettings/sidebarLayout roll back on audit failure — authSettings', () => {
  const fullSettings = (openRegistration: boolean, expectedRevision = 0) => ({
    emailDomainAllowlist: [] as string[],
    emailDomainAllowlistEnabled: false,
    expectedRevision,
    openRegistration,
  });

  it('commits settings + audit together on success', async () => {
    const caller = await callerFor();
    const next = await caller.update(fullSettings(false, 0));
    expect(next.openRegistration).toBe(false);
    expect(next.revision).toBe(1);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.authSettings.update',
        result: 'success',
      }),
    );
    const rows = await db.select().from(platformAuthSettings);
    expect(rows[0]?.openRegistration).toBe(false);
  });

  it('rolls back the settings write when the audit append fails', async () => {
    const caller = await callerFor();
    // Establish a known baseline.
    await caller.update(fullSettings(true, 0));
    appendSpy.mockRejectedValueOnce(new Error('audit sink unavailable'));

    await expect(caller.update(fullSettings(false, 1))).rejects.toBeTruthy();

    const rows = await db.select().from(platformAuthSettings);
    // Transaction rolled back — open registration stays true.
    expect(rows[0]?.openRegistration).toBe(true);
  });

  it('lets identity readers get settings', async () => {
    const caller = await callerFor(ids.reader);
    await expect(caller.get()).resolves.toMatchObject({
      openRegistration: expect.any(Boolean),
      revision: expect.any(Number),
    });
  });

  it('requires IDENTITY_UPDATE for update and records a sanitized denial audit', async () => {
    const admin = await callerFor(ids.admin);
    await admin.update(fullSettings(true, 0));
    const before = await db.select().from(platformAuthSettings);
    expect(before[0]?.openRegistration).toBe(true);
    expect(before[0]?.revision).toBe(1);

    const reader = await callerFor(ids.reader);
    await expect(reader.update(fullSettings(false, 1))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const after = await db.select().from(platformAuthSettings);
    expect(after[0]?.openRegistration).toBe(true);
    expect(after[0]?.revision).toBe(1);
    // Denial audit is written via PlatformAuditLogModel (not PlatformAuditService).
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.permission.denied',
        result: 'denied',
      }),
    );
    const denied = (await db.select().from(platformAuditLogs)).find(
      (row) => row.action === 'admin.permission.denied',
    );
    expect(denied?.afterDiff).toEqual(
      expect.objectContaining({
        permission: PLATFORM_PERMISSIONS.IDENTITY_UPDATE,
      }),
    );
  });

  it('rejects enabled allowlist with empty domains at the router input boundary (not handler parse)', async () => {
    const caller = await callerFor();
    const error = await caller
      .update({
        emailDomainAllowlist: [],
        emailDomainAllowlistEnabled: true,
        expectedRevision: 0,
        openRegistration: true,
      })
      .then(
        () => {
          throw new Error('expected input rejection');
        },
        (err: unknown) => err,
      );

    // Discriminating vs pre-fix: old local input accepted the payload, handler
    // threw ZodError → PLATFORM_INVALID_INPUT (enterprise body). Post-fix the shared
    // contract rejects at `.input()` with a raw ZodError cause and no enterprise body.
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(ZodError);
    const zod = (error as { cause: ZodError }).cause;
    expect(zod.issues.some((issue) => issue.message === 'EMAIL_DOMAIN_ALLOWLIST_REQUIRED')).toBe(
      true,
    );
    expect(getEnterpriseErrorBody(error)).toBeNull();
    // Handler audit path never runs when `.input()` rejects.
    expect(appendSpy).not.toHaveBeenCalled();
    const rows = await db.select().from(platformAuthSettings);
    expect(rows).toHaveLength(0);
  });
});
