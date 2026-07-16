// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAiModels,
  platformAiProviders,
  platformAuditLogs,
  platformResourceRevisions,
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
  aiAdmin: 'm07-ai-admin',
  auditor: 'm07-auditor',
  normal: 'm07-normal',
};

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformAiModels);
  await db.delete(platformAiProviders);
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
    roleName: PLATFORM_SYSTEM_ROLES.AUDITOR,
    userId: ids.auditor,
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

const callerFor = async (userId: string, authenticatedAt: Date | null = new Date()) =>
  createCaller({
    ...(await createContextInner({ authenticatedAt, authMethod: 'better-auth', userId })),
    serverDB: db,
  } as never);

describe('admin AI catalog permission and reauth gates', () => {
  it('denies ordinary users and writes a sanitized permission audit', async () => {
    const caller = await callerFor(ids.normal);
    await expect(caller.aiProviders.list({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.permission.denied', result: 'denied' }),
    );
  });

  it('lets auditors list but not open update-scoped detail or mutate', async () => {
    const caller = await callerFor(ids.auditor);
    await expect(caller.aiProviders.list({ limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(caller.aiProviders.get({ id: 'missing' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller.aiProviders.createDraft({
        displayName: 'Denied',
        providerKey: 'denied',
        reason: 'auditor cannot create',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns secret metadata only and denies stale publish reauth before mutation', async () => {
    const caller = await callerFor(ids.aiAdmin);
    const provider = await caller.aiProviders.createDraft({
      displayName: 'Alpha',
      enabled: true,
      providerKey: 'alpha',
      reason: 'create',
      secret: { operation: 'replace', value: 'fake-key' },
    });
    expect(provider.secret.configured).toBe(true);
    expect(JSON.stringify(provider)).not.toContain('fake-key');
    const detail = await caller.aiProviders.get({ id: provider.id });

    const staleCaller = await callerFor(ids.aiAdmin, new Date(Date.now() - 60 * 60 * 1000));
    await expect(
      staleCaller.aiProviders.publish({
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'stale reauth',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(0);
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({
        action: 'admin.aiProviders.publish',
        result: 'denied',
      }),
    );
  });
});
