// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformGlobalCredentials,
  platformGlobalCredentialSecrets,
  platformGlobalCredentialUploads,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(adminRouter);
const ids = {
  aiAdmin: 'w10e-ai-admin',
  normal: 'w10e-normal',
};

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  // Audit logs are append-only (row triggers); TRUNCATE is the test cleanup path.
  await db.execute(sql.raw('TRUNCATE TABLE platform_audit_logs CASCADE'));
  await db.delete(platformGlobalCredentialSecrets);
  await db.delete(platformGlobalCredentialUploads);
  await db.delete(platformGlobalCredentials);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 37).toString('base64'));
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
    userId: ids.aiAdmin,
  });
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    userId: ids.normal,
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (
  userId: string,
  auth: { authenticatedAt?: Date | null; authMethod?: 'api-key' | 'better-auth' } = {
    authenticatedAt: new Date(),
    authMethod: 'better-auth',
  },
) =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: auth.authenticatedAt,
      authMethod: auth.authMethod ?? 'better-auth',
      userId,
    })),
    serverDB: db,
  } as never);

describe('admin.creds router', () => {
  it('get returns configured masks without plaintext secret material', async () => {
    const caller = await callerFor(ids.aiAdmin);
    const created = await caller.creds.createKV({
      key: 'router-mask',
      name: 'Router Mask',
      type: 'kv-env',
      values: { TOKEN: 'router-test-secret-placeholder' },
    });

    const detail = await caller.creds.get({ decrypt: true, id: created.id });
    expect(detail.configured).toBe(true);
    expect(detail.plaintext?.TOKEN).toBe('••••••••');
    expect(JSON.stringify(detail)).not.toContain('router-test-secret-placeholder');

    const successAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.creds.createKV' && row.result === 'success',
    );
    expect(successAudits.length).toBeGreaterThanOrEqual(1);
  });

  it('writes denied audit when reauth is required', async () => {
    const stale = await callerFor(ids.aiAdmin, {
      authenticatedAt: null,
      authMethod: 'better-auth',
    });
    await expect(
      stale.creds.createKV({
        key: 'reauth-block',
        name: 'Blocked',
        type: 'kv-env',
        values: { K: 'v' },
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const denied = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.creds.createKV' && row.result === 'denied',
    );
    expect(denied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: ids.aiAdmin,
          afterDiff: { error: 'reauth_required' },
        }),
      ]),
    );
  });

  it('rejects createOAuth for platform global credentials', async () => {
    const caller = await callerFor(ids.aiAdmin);
    await expect(
      caller.creds.createOAuth({
        key: 'oauth-nope',
        name: 'No OAuth',
        oauthConnectionId: 1,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/oauth|not support/i),
    });
  });
});
