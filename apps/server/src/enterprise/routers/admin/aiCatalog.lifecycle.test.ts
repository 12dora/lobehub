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

import {
  InMemoryAdminMutationRateLimiter,
  resetSharedAdminMutationRateLimiter,
  setSharedAdminMutationRateLimiter,
} from '../../security/rateLimit/adminMutationRateLimiter';
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

const createProviderInput = (
  providerKey: string,
  secret?: { operation: 'clear' | 'keep' } | { operation: 'replace'; value: string },
  reason = 'create provider draft',
) => ({ displayName: providerKey, providerKey, reason, secret });

describe('admin AI catalog publication, models, and delete lifecycle', () => {
  /** Seed a first-publishable provider: enabled + model + fresh connection test row. */
  const seedPublishableProvider = async (providerKey: string) => {
    const caller = await callerFor(ids.aiAdmin);
    const credential = `seed-credential-${providerKey}`;
    const provider = await caller.aiProviders.createDraft({
      checkModel: 'chat',
      displayName: providerKey,
      enabled: true,
      providerKey,
      reason: 'seed draft',
      secret: { operation: 'replace', value: credential },
      settings: { sdkType: 'openai' },
    });
    let detail = await caller.aiProviders.get({ id: provider.id });
    await caller.aiModels.create({
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'seed model',
      type: 'chat',
    });
    detail = await caller.aiProviders.get({ id: provider.id });
    // Mark connection test success bound to the current draft (no live network in unit tests).
    await db
      .update(platformAiProviders)
      .set({
        connectionTestErrorCategory: null,
        connectionTestLatencyMs: 12,
        connectionTestSanitizedMessage: 'ok',
        connectionTestStatus: 'success',
        connectionTestedAt: new Date(),
        connectionTestedDraftToken: detail.draftToken,
        connectionTestedRevision: detail.baseRevision,
      })
      .where(eq(platformAiProviders.id, provider.id));
    detail = await caller.aiProviders.get({ id: provider.id });
    const published = await caller.aiProviders.publish({
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: provider.id,
      reason: 'seed publish',
    });
    return { caller, credential, providerId: provider.id, published };
  };

  it('applyImmediate update republishes an already-published provider', async () => {
    const { caller, credential, providerId } = await seedPublishableProvider('immediate-p');
    const detail = await caller.aiProviders.get({ id: providerId });
    const updated = await caller.aiProviders.applyImmediate({
      displayName: 'Immediate Renamed',
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: providerId,
      mode: 'update',
      reason: 'rename immediately',
    });
    expect(updated.draft.displayName).toBe('Immediate Renamed');
    expect(updated.published).toBe(true);
    expect(updated.revision).toBeGreaterThan(0);
    expect(JSON.stringify(updated)).not.toContain(credential);
  });

  it('applyImmediate create keeps draft when first publish is not yet valid', async () => {
    const caller = await callerFor(ids.aiAdmin);
    const result = await caller.aiProviders.applyImmediate({
      displayName: 'Draft Only',
      mode: 'create',
      providerKey: 'draft-only-p',
      reason: 'create without models/test',
      secret: { operation: 'replace', value: 'not-a-real-secret-value' },
      settings: { sdkType: 'openai' },
    });
    expect(result.published).toBe(false);
    expect(result.draft.providerKey).toBe('draft-only-p');
    expect(result.revision).toBe(0);
    expect(JSON.stringify(result)).not.toContain('not-a-real-secret-value');
  });

  it('applyImmediate denies callers without publish permission', async () => {
    const caller = await callerFor(ids.modelEditor);
    await expect(
      caller.aiProviders.applyImmediate({
        displayName: 'Nope',
        mode: 'create',
        providerKey: 'nope',
        reason: 'denied',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('applyImmediate rejects stale reauth before mutating', async () => {
    const { providerId } = await seedPublishableProvider('reauth-gate');
    const fresh = await callerFor(ids.aiAdmin);
    const detail = await fresh.aiProviders.get({ id: providerId });
    const stale = await callerFor(ids.aiAdmin, new Date(Date.now() - 60 * 60 * 1000));
    await expect(
      stale.aiProviders.applyImmediate({
        displayName: 'Blocked',
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: providerId,
        mode: 'update',
        reason: 'stale reauth blocked',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('aiModels.applyImmediate create/update/delete/reorder/batch on published provider', async () => {
    const { caller, providerId } = await seedPublishableProvider('models-ops');
    let detail = await caller.aiProviders.get({ id: providerId });

    const created = await caller.aiModels.applyImmediate({
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'extra',
      operation: 'create',
      providerId,
      reason: 'create model',
      type: 'chat',
    });
    expect(created.published).toBe(true);
    detail = await caller.aiProviders.get({ id: providerId });
    const extra = detail.draft.models.find((m) => m.modelKey === 'extra');
    expect(extra).toBeTruthy();

    const updated = await caller.aiModels.applyImmediate({
      displayName: 'Extra Renamed',
      expectedDraftToken: detail.draftToken,
      expectedRevision: extra!.revision,
      id: extra!.id,
      operation: 'update',
      providerId,
      reason: 'rename model',
    });
    expect(updated.published).toBe(true);

    detail = await caller.aiProviders.get({ id: providerId });
    const toggled = await caller.aiModels.applyImmediate({
      enabled: false,
      expectedDraftToken: detail.draftToken,
      modelIds: [extra!.id],
      operation: 'batchToggle',
      providerId,
      reason: 'batch toggle',
    });
    expect(toggled.published).toBe(true);

    detail = await caller.aiProviders.get({ id: providerId });
    const reorderItems = detail.draft.models.map((m, sort) => ({ id: m.id, sort }));
    const reordered = await caller.aiModels.applyImmediate({
      expectedDraftToken: detail.draftToken,
      items: reorderItems,
      operation: 'reorder',
      providerId,
      reason: 'reorder',
    });
    expect(reordered.published).toBe(true);

    detail = await caller.aiProviders.get({ id: providerId });
    const deleted = await caller.aiModels.applyImmediate({
      expectedDraftToken: detail.draftToken,
      id: extra!.id,
      operation: 'delete',
      providerId,
      reason: 'delete model',
    });
    expect(deleted.published).toBe(true);
  });

  it('aiModels.applyImmediate denies model editor without publish permission', async () => {
    const { providerId } = await seedPublishableProvider('models-deny');
    const detail = await (await callerFor(ids.aiAdmin)).aiProviders.get({ id: providerId });
    const modelEditor = await callerFor(ids.modelEditor);
    await expect(
      modelEditor.aiModels.applyImmediate({
        enabled: true,
        expectedDraftToken: detail.draftToken,
        modelKey: 'nope',
        operation: 'create',
        providerId,
        reason: 'denied',
        type: 'chat',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('publishNow requires reauth like other publish mutations', async () => {
    const { providerId } = await seedPublishableProvider('publish-now-reauth');
    const stale = await callerFor(ids.aiAdmin, new Date(Date.now() - 60 * 60 * 1000));
    await expect(
      stale.aiProviders.publishNow({ id: providerId, reason: 'stale' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('applyImmediate is rate-limited with ADMIN_RATE_LIMITED when window is exhausted', async () => {
    setSharedAdminMutationRateLimiter(
      new InMemoryAdminMutationRateLimiter({
        config: { limit: 1, windowMs: 60_000 },
      }),
    );
    try {
      const caller = await callerFor(ids.aiAdmin);
      // First mutation consumes the sole quota unit.
      await caller.aiProviders.applyImmediate({
        displayName: 'Rate Limited A',
        mode: 'create',
        providerKey: 'rate-limit-a',
        reason: 'consume quota',
        settings: { sdkType: 'openai' },
      });
      // Second hits the boundary regardless of business outcome.
      await expect(
        caller.aiProviders.applyImmediate({
          displayName: 'Rate Limited B',
          mode: 'create',
          providerKey: 'rate-limit-b',
          reason: 'should 429',
          settings: { sdkType: 'openai' },
        }),
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        message: expect.stringMatching(/ADMIN_RATE_LIMITED/),
      });
    } finally {
      resetSharedAdminMutationRateLimiter();
    }
  });

  const seedDeletableProvider = async (providerKey: string) => {
    const caller = await callerFor(ids.aiAdmin);
    const provider = await caller.aiProviders.createDraft({
      displayName: providerKey,
      enabled: true,
      providerKey,
      reason: 'seed deletable draft',
      secret: { operation: 'replace', value: `del-credential-${providerKey}` },
      settings: { sdkType: 'openai' },
    });
    const detail = await caller.aiProviders.get({ id: provider.id });
    await caller.aiModels.create({
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'seed deletable model',
      type: 'chat',
    });
    return { caller, providerId: provider.id };
  };

  const providerRows = (providerId: string) =>
    db.select().from(platformAiProviders).where(eq(platformAiProviders.id, providerId));
  const modelRows = (providerId: string) =>
    db.select().from(platformAiModels).where(eq(platformAiModels.providerId, providerId));
  const secretRows = (providerId: string) =>
    db
      .select()
      .from(platformAiProviderSecrets)
      .where(eq(platformAiProviderSecrets.providerId, providerId));
  const revisionRows = (providerId: string) =>
    db
      .select()
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'provider'),
          eq(platformResourceRevisions.resourceId, providerId),
        ),
      );

  it('hard-deletes a draft provider with its models and secret, and writes a success audit', async () => {
    const { caller, providerId } = await seedDeletableProvider('delete-draft');

    await expect(
      caller.aiProviders.delete({ id: providerId, reason: 'remove test provider' }),
    ).resolves.toEqual({ deleted: true });

    expect(await providerRows(providerId)).toHaveLength(0);
    expect(await modelRows(providerId)).toHaveLength(0);
    expect(await secretRows(providerId)).toHaveLength(0);
    const audits = await db.select().from(platformAuditLogs);
    expect(
      audits.some(
        ({ action, result, targetId }) =>
          action === 'admin.aiProviders.delete' && result === 'success' && targetId === providerId,
      ),
    ).toBe(true);
  });

  it('hard-deletes a published provider and removes its revision-log rows', async () => {
    const { providerId } = await seedPublishableProvider('delete-published');
    // Published provider owns at least one revision row.
    expect((await revisionRows(providerId)).length).toBeGreaterThan(0);

    const caller = await callerFor(ids.aiAdmin);
    await expect(
      caller.aiProviders.delete({ id: providerId, reason: 'remove published provider' }),
    ).resolves.toEqual({ deleted: true });

    expect(await providerRows(providerId)).toHaveLength(0);
    expect(await modelRows(providerId)).toHaveLength(0);
    expect(await revisionRows(providerId)).toHaveLength(0);
  });

  it('rejects a stale-reauth delete before mutating and records a denied audit', async () => {
    const { providerId } = await seedDeletableProvider('delete-stale-reauth');
    const stale = await callerFor(ids.aiAdmin, { authenticatedAt: null });

    await expect(
      stale.aiProviders.delete({ id: providerId, reason: 'stale reauth delete' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(await providerRows(providerId)).toHaveLength(1);
    const audits = await db.select().from(platformAuditLogs);
    expect(
      audits.some(
        ({ action, result }) => action === 'admin.aiProviders.delete' && result === 'denied',
      ),
    ).toBe(true);
  });

  it('denies an ordinary user without AI_PROVIDER_DELETE', async () => {
    const { providerId } = await seedDeletableProvider('delete-forbidden');
    const ordinary = await callerFor(ids.normal);

    await expect(
      ordinary.aiProviders.delete({ id: providerId, reason: 'no permission' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await providerRows(providerId)).toHaveLength(1);
  });
});
