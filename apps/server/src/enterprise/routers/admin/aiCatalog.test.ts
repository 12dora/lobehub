// @vitest-environment node
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
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
  modelEditor: 'm07-model-editor',
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
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    userId: ids.modelEditor,
  });
  const [modelEditorRole] = await db
    .insert(roles)
    .values({
      displayName: 'Model editor',
      id: 'm07-model-editor-role',
      name: 'm07_model_editor',
      workspaceId: null,
    })
    .returning();
  const modelPermissions = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      inArray(permissions.code, [
        PLATFORM_PERMISSIONS.AI_MODEL_CREATE,
        PLATFORM_PERMISSIONS.AI_MODEL_DELETE,
        PLATFORM_PERMISSIONS.AI_MODEL_READ,
        PLATFORM_PERMISSIONS.AI_MODEL_UPDATE,
      ]),
    );
  await db
    .insert(rolePermissions)
    .values(modelPermissions.map(({ id }) => ({ permissionId: id, roleId: modelEditorRole.id })));
  await db.insert(userRoles).values({
    roleId: modelEditorRole.id,
    userId: ids.modelEditor,
    workspaceId: null,
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
    await expect(
      caller.aiModels.getCreateDraftContext({ providerId: 'missing' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.aiModels.listCreateTargets({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.permission.denied', result: 'denied' }),
    );
  });

  it('lets auditors list and open read-only detail but not mutate', async () => {
    const caller = await callerFor(ids.auditor);
    await expect(caller.aiProviders.list({ limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(caller.aiProviders.get({ id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      caller.aiProviders.createDraft({
        displayName: 'Denied',
        providerKey: 'denied',
        reason: 'auditor cannot create',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.aiModels.getUpdateDraftContext({ providerId: 'missing' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.aiModels.listCreateTargets({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns secret metadata only and denies stale publish reauth before mutation', async () => {
    const caller = await callerFor(ids.aiAdmin);
    const credential = 'reauth-plain-credential-value';
    const provider = await caller.aiProviders.createDraft({
      displayName: 'Alpha',
      enabled: true,
      providerKey: 'alpha',
      reason: 'create',
      secret: { operation: 'replace', value: credential },
    });
    expect(provider.secret.configured).toBe(true);
    expect(JSON.stringify(provider)).not.toContain(credential);
    const detail = await caller.aiProviders.get({ id: provider.id });

    const staleCaller = await callerFor(ids.aiAdmin, new Date(Date.now() - 60 * 60 * 1000));
    await expect(
      staleCaller.aiProviders.publish({
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: `stale reauth ${credential}`,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(0);
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.aiProviders.publish',
        result: 'denied',
      }),
    );
    expect(JSON.stringify(audits)).not.toContain(credential);
  });

  it('returns a fixed validation error without reflecting arbitrary credentials', async () => {
    const caller = await callerFor(ids.aiAdmin);
    const credential = 'router-arbitrary-credential-leaf';
    let thrown: unknown;
    try {
      await caller.aiProviders.createDraft({
        displayName: `copied:${credential}`,
        providerKey: 'router-rejected',
        reason: 'create rejected',
        secret: { operation: 'replace', value: credential },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(JSON.stringify(thrown)).not.toContain(credential);
    expect(await db.select().from(platformAiProviders)).toEqual([]);
  });

  it('lets a model-only global role obtain CAS context and mutate without provider update', async () => {
    const [provider] = await db
      .insert(platformAiProviders)
      .values({ displayName: 'Model-only target', providerKey: 'model-only' })
      .returning();
    const caller = await callerFor(ids.modelEditor);
    await expect(caller.aiProviders.get({ id: provider.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    let context = await caller.aiModels.getCreateDraftContext({ providerId: provider.id });
    const model = await caller.aiModels.create({
      enabled: true,
      expectedDraftToken: context.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'model-only create',
    });
    context = await caller.aiModels.getUpdateDraftContext({ providerId: provider.id });
    const updated = await caller.aiModels.update({
      displayName: 'Updated',
      expectedDraftToken: context.draftToken,
      expectedRevision: context.baseRevision,
      id: model.id,
      providerId: provider.id,
      reason: 'model-only update',
    });
    expect(updated.displayName).toBe('Updated');
    context = await caller.aiModels.getDeleteDraftContext({ providerId: provider.id });
    await expect(
      caller.aiModels.deleteFromDraft({
        expectedDraftToken: context.draftToken,
        id: model.id,
        providerId: provider.id,
        reason: 'model-only delete',
      }),
    ).resolves.toEqual({ deleted: true });
  });

  it('lets model creators discover empty providers through a paged secret-free target list', async () => {
    await db.insert(platformAiProviders).values([
      {
        config: { endpoint: 'https://private-target.example.test' },
        displayName: 'Alpha Empty',
        encryptedKeyVaults: 'ciphertext-must-not-leak',
        providerKey: 'alpha-empty',
        settings: { sdkType: 'openai' },
      },
      { displayName: 'Beta Empty', providerKey: 'beta-empty' },
    ]);
    const caller = await callerFor(ids.modelEditor);

    const first = await caller.aiModels.listCreateTargets({ limit: 1 });
    expect(first.items).toEqual([
      { displayName: 'Alpha Empty', id: expect.any(String), providerKey: 'alpha-empty' },
    ]);
    expect(first.nextCursor).toBe('alpha-empty');
    const second = await caller.aiModels.listCreateTargets({
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(second.items).toEqual([
      { displayName: 'Beta Empty', id: expect.any(String), providerKey: 'beta-empty' },
    ]);
    expect(second.nextCursor).toBeNull();
    await expect(caller.aiModels.listCreateTargets({ limit: 10, query: 'Beta' })).resolves.toEqual({
      items: [{ displayName: 'Beta Empty', id: expect.any(String), providerKey: 'beta-empty' }],
      nextCursor: null,
    });
    expect(JSON.stringify([first, second])).not.toContain('private-target');
    expect(JSON.stringify([first, second])).not.toContain('ciphertext');
    expect(Object.keys(first.items[0]).sort()).toEqual(['displayName', 'id', 'providerKey']);
  });
});
