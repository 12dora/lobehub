// @vitest-environment node
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
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

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(adminRouter);
const ids = {
  aiAdmin: 'm07-ai-admin',
  auditor: 'm07-auditor',
  modelEditor: 'm07-model-editor',
  /** May publish and update models, but must never create one. */
  modelUpdater: 'm07-model-updater',
  normal: 'm07-normal',
};

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(ids) });
  const ownedProviders = await db.select({ id: platformAiProviders.id }).from(platformAiProviders);
  await deletePlatformResourceRevisionsForTest(db, {
    resourceIds: ownedProviders.map((row) => row.id),
    resourceType: 'provider',
  });
  await db.delete(platformAiModels);
  await db.delete(platformAiProviderSecrets);
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

  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    userId: ids.modelUpdater,
  });
  const [modelUpdaterRole] = await db
    .insert(roles)
    .values({
      displayName: 'Model updater',
      id: 'm07-model-updater-role',
      name: 'm07_model_updater',
      workspaceId: null,
    })
    .returning();
  // Everything aiModels.applyImmediate's compound gate asks of a batchUpdate — minus CREATE.
  const updaterPermissions = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      inArray(permissions.code, [
        PLATFORM_PERMISSIONS.AI_MODEL_PUBLISH,
        PLATFORM_PERMISSIONS.AI_MODEL_READ,
        PLATFORM_PERMISSIONS.AI_MODEL_UPDATE,
        PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
        PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
      ]),
    );
  await db
    .insert(rolePermissions)
    .values(
      updaterPermissions.map(({ id }) => ({ permissionId: id, roleId: modelUpdaterRole.id })),
    );
  await db.insert(userRoles).values({
    roleId: modelUpdaterRole.id,
    userId: ids.modelUpdater,
    workspaceId: null,
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (
  userId: string,
  auth: Date | null | { authenticatedAt?: Date | null; authMethod?: 'api-key' | 'better-auth' } = {
    authenticatedAt: new Date(),
    authMethod: 'better-auth',
  },
) => {
  const resolved =
    auth instanceof Date || auth === null
      ? { authenticatedAt: auth, authMethod: 'better-auth' as const }
      : auth;
  return createCaller({
    ...(await createContextInner({
      authenticatedAt: resolved.authenticatedAt,
      authMethod: resolved.authMethod ?? 'better-auth',
      userId,
    })),
    serverDB: db,
  } as never);
};

const applyCreate = (
  providerKey: string,
  secret?: { operation: 'clear' | 'keep' } | { operation: 'replace'; value: string },
  reason = 'create provider',
) => ({ displayName: providerKey, mode: 'create' as const, providerKey, reason, secret });

describe('admin AI catalog permission and reauth gates', () => {
  it('gates every create variant for every unsupported auth state, including keep/absent', async () => {
    const authStates = [
      { authenticatedAt: null, authMethod: 'better-auth' as const },
      {
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth' as const,
      },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ];
    let attempt = 0;
    for (const auth of authStates) {
      // applyImmediate publishes site-wide, so reauth is unconditional: a secret-free
      // create is gated exactly like a credential replacement.
      for (const operation of ['replace', 'clear', 'keep', 'absent'] as const) {
        const providerKey = `guarded-create-${attempt++}`;
        const secretValue = `router-create-value-${attempt}`;
        const secret =
          operation === 'replace'
            ? ({ operation, value: secretValue } as const)
            : operation === 'absent'
              ? undefined
              : ({ operation } as const);
        await expect(
          (await callerFor(ids.aiAdmin, auth)).aiProviders.applyImmediate(
            applyCreate(
              providerKey,
              secret,
              operation === 'replace' ? `denied ${secretValue}` : `denied ${operation}`,
            ),
          ),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
    }

    expect(await db.select().from(platformAiProviders)).toEqual([]);
    expect(await db.select().from(platformAiProviderSecrets)).toEqual([]);
    const audits = (await db.select().from(platformAuditLogs)).filter(
      ({ action }) => action === 'admin.aiProviders.applyImmediate',
    );
    expect(audits).toHaveLength(12);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: ids.aiAdmin,
          afterDiff: { error: 'reauth_required' },
          reason: null,
          result: 'denied',
          targetId: 'guarded-create-0',
          targetType: 'provider',
        }),
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain('router-create-value');
  });

  it('gates every update variant before any draft or secret write', async () => {
    const fresh = await callerFor(ids.aiAdmin);
    const created = await fresh.aiProviders.applyImmediate(applyCreate('guarded-update'));
    const detail = await fresh.aiProviders.get({ id: created.draft.id });
    const authStates = [
      { authenticatedAt: null, authMethod: 'better-auth' as const },
      {
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth' as const,
      },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ];
    let attempt = 0;
    for (const auth of authStates) {
      for (const operation of ['replace', 'clear', 'keep'] as const) {
        const secretValue = `router-update-value-${attempt++}`;
        const secret =
          operation === 'replace'
            ? ({ operation, value: secretValue } as const)
            : ({ operation } as const);
        await expect(
          (await callerFor(ids.aiAdmin, auth)).aiProviders.applyImmediate({
            displayName: `denied-${attempt}`,
            expectedDraftToken: detail.draftToken,
            expectedRevision: detail.baseRevision,
            id: created.draft.id,
            mode: 'update',
            reason: operation === 'replace' ? `denied ${secretValue}` : `denied ${operation}`,
            secret,
          }),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
    }

    expect(
      await db
        .select({
          displayName: platformAiProviders.displayName,
          revision: platformAiProviders.revision,
        })
        .from(platformAiProviders)
        .where(eq(platformAiProviders.id, created.draft.id)),
    ).toEqual([{ displayName: 'guarded-update', revision: created.revision }]);
    expect(await db.select().from(platformAiProviderSecrets)).toEqual([]);
    const denied = (await db.select().from(platformAuditLogs)).filter(
      ({ action, result }) => action === 'admin.aiProviders.applyImmediate' && result === 'denied',
    );
    expect(denied).toHaveLength(9);
    expect(
      denied.every(
        ({ actorUserId, afterDiff, targetId, targetType }) =>
          actorUserId === ids.aiAdmin &&
          JSON.stringify(afterDiff) === JSON.stringify({ error: 'reauth_required' }) &&
          targetId === created.draft.id &&
          targetType === 'provider',
      ),
    ).toBe(true);
    expect(JSON.stringify(denied)).not.toContain('router-update-value');
  });

  it('accepts a fresh session for a credential replacement and stores exactly one version', async () => {
    const fresh = await callerFor(ids.aiAdmin);
    const created = await fresh.aiProviders.applyImmediate(applyCreate('fresh-replacement'));
    const detail = await fresh.aiProviders.get({ id: created.draft.id });
    const replaced = await fresh.aiProviders.applyImmediate({
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.draft.id,
      mode: 'update',
      reason: 'fresh replacement',
      secret: { operation: 'replace', value: 'fresh-router-replacement' },
    });
    expect(replaced.draft.secret.configured).toBe(true);
    expect(replaced.revision).toBeGreaterThan(created.revision);
    expect(await db.select().from(platformAiProviderSecrets)).toHaveLength(1);
  });

  it('still rejects create replacement when the denied audit sink fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const insert = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('audit sink unavailable');
    });
    await expect(
      (await callerFor(ids.aiAdmin, { authenticatedAt: null })).aiProviders.applyImmediate(
        applyCreate('audit-failure', {
          operation: 'replace',
          value: 'never-written-secret',
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await db.select().from(platformAiProviders)).toEqual([]);
    expect(await db.select().from(platformAiProviderSecrets)).toEqual([]);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('never-written-secret');
    insert.mockRestore();
    consoleError.mockRestore();
  });

  it('denies ordinary users and writes a sanitized permission audit', async () => {
    const caller = await callerFor(ids.normal);
    await expect(caller.aiProviders.list({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.aiModels.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.aiModels.dependents({ id: 'missing', providerId: 'missing' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
      caller.aiProviders.applyImmediate(applyCreate('denied', undefined, 'auditor cannot create')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies a model-only role every write while leaving model reads open', async () => {
    // Model writes now go through the parent-provider publish, so AI_MODEL_* alone is
    // never enough — there is no draft-context/draft-DML back door left.
    const [provider] = await db
      .insert(platformAiProviders)
      .values({ displayName: 'Model-only target', providerKey: 'model-only' })
      .returning();
    const caller = await callerFor(ids.modelEditor);

    await expect(caller.aiProviders.get({ id: provider.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.aiModels.list({ limit: 10 })).resolves.toMatchObject({ items: [] });
    await expect(
      caller.aiModels.applyImmediate({
        enabled: true,
        expectedDraftToken: '0'.repeat(64),
        modelKey: 'chat',
        operation: 'create',
        providerId: provider.id,
        reason: 'model-only create',
        type: 'chat',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await db.select().from(platformAiModels)).toEqual([]);
  });

  it('denies an inserting batchUpdate to a role without AI_MODEL_CREATE, but allows pure updates', async () => {
    // `batchUpdate` decides insert-vs-update from database state, so the router's input-only
    // compound gate cannot classify it — an update-only role must not be able to create
    // arbitrary models through the upsert branch.
    const admin = await callerFor(ids.aiAdmin);
    const created = await admin.aiProviders.applyImmediate({
      displayName: 'Least privilege',
      enabled: true,
      mode: 'create',
      providerKey: 'least-privilege',
      reason: 'seed provider',
      settings: { sdkType: 'openai' },
    });
    let detail = await admin.aiProviders.get({ id: created.draft.id });
    await admin.aiModels.applyImmediate({
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      operation: 'create',
      providerId: created.draft.id,
      reason: 'seed model',
      type: 'chat',
    });

    detail = await admin.aiProviders.get({ id: created.draft.id });
    const existing = detail.draft.models[0]!;
    const updater = await callerFor(ids.modelUpdater);

    // Pure update: allowed with UPDATE + PUBLISH only.
    await expect(
      updater.aiModels.applyImmediate({
        expectedDraftToken: detail.draftToken,
        models: [{ displayName: 'Renamed by updater', id: existing.id }],
        operation: 'batchUpdate',
        providerId: created.draft.id,
        reason: 'pure update batch',
      }),
    ).resolves.toMatchObject({ revision: expect.any(Number) });

    detail = await admin.aiProviders.get({ id: created.draft.id });
    expect(detail.draft.models[0]!.displayName).toBe('Renamed by updater');

    // Same procedure, same declared operation — but this item would INSERT.
    await expect(
      updater.aiModels.applyImmediate({
        expectedDraftToken: detail.draftToken,
        models: [
          { displayName: 'Renamed again', id: existing.id },
          { displayName: 'Smuggled', enabled: true, id: 'smuggled-model-key', type: 'chat' },
        ],
        operation: 'batchUpdate',
        providerId: created.draft.id,
        reason: 'inserting batch must be denied',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Atomic: the accompanying rename rolled back with the denied insert.
    const after = await admin.aiProviders.get({ id: created.draft.id });
    expect(after.draft.models).toHaveLength(1);
    expect(after.draft.models[0]!.displayName).toBe('Renamed by updater');
  });

  it('returns secret metadata only and denies a stale-reauth apply before mutation', async () => {
    const caller = await callerFor(ids.aiAdmin);
    const credential = 'reauth-plain-credential-value';
    const created = await caller.aiProviders.applyImmediate({
      displayName: 'Alpha',
      enabled: true,
      mode: 'create',
      providerKey: 'alpha',
      reason: 'create',
      secret: { operation: 'replace', value: credential },
    });
    expect(created.draft.secret.configured).toBe(true);
    expect(JSON.stringify(created)).not.toContain(credential);
    const detail = await caller.aiProviders.get({ id: created.draft.id });

    const staleCaller = await callerFor(ids.aiAdmin, new Date(Date.now() - 60 * 60 * 1000));
    await expect(
      staleCaller.aiProviders.applyImmediate({
        displayName: 'Blocked',
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: created.draft.id,
        mode: 'update',
        reason: `stale reauth ${credential}`,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // No new revision beyond the one the create published.
    expect(
      await db
        .select()
        .from(platformResourceRevisions)
        .where(
          and(
            eq(platformResourceRevisions.resourceType, 'provider'),
            eq(platformResourceRevisions.resourceId, created.draft.id),
          ),
        ),
    ).toHaveLength(created.revision);
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.aiProviders.applyImmediate',
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
      await caller.aiProviders.applyImmediate({
        displayName: `copied:${credential}`,
        mode: 'create',
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
});
