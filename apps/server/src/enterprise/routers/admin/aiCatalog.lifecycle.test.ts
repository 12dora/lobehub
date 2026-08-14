// @vitest-environment node
import { and, eq, inArray, sql } from 'drizzle-orm';
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

/** Append-only audit rows cannot be DELETE'd (0145); TRUNCATE bypasses the row trigger. */
const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformAiModels},
      ${platformAiProviderSecrets},
      ${platformAiProviders},
      ${userRoles},
      ${rolePermissions},
      ${roles},
      ${permissions},
      ${users}
    RESTART IDENTITY CASCADE
  `);
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

describe('admin AI catalog publication, models, and delete lifecycle', () => {
  /** Seed a live provider through the only write path: applyImmediate (create + publish). */
  const seedPublishedProvider = async (providerKey: string) => {
    const caller = await callerFor(ids.aiAdmin);
    const credential = `seed-credential-${providerKey}`;
    const created = await caller.aiProviders.applyImmediate({
      checkModel: 'chat',
      displayName: providerKey,
      enabled: true,
      mode: 'create',
      providerKey,
      reason: 'seed provider',
      secret: { operation: 'replace', value: credential },
      settings: { sdkType: 'openai' },
    });
    expect(created.revision).toBeGreaterThan(0);
    const detail = await caller.aiProviders.get({ id: created.draft.id });
    const published = await caller.aiModels.applyImmediate({
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      operation: 'create',
      providerId: created.draft.id,
      reason: 'seed model',
      type: 'chat',
    });
    return { caller, credential, providerId: created.draft.id, published };
  };

  it('applyImmediate update republishes an already-published provider', async () => {
    const { caller, credential, providerId } = await seedPublishedProvider('immediate-p');
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
    expect(updated.revision).toBeGreaterThan(detail.baseRevision);
    expect(JSON.stringify(updated)).not.toContain(credential);
  });

  it('applyImmediate create publishes immediately with no models and no connection test', async () => {
    const caller = await callerFor(ids.aiAdmin);
    const result = await caller.aiProviders.applyImmediate({
      displayName: 'Live On Create',
      enabled: true,
      mode: 'create',
      providerKey: 'live-on-create',
      reason: 'create goes live',
      secret: { operation: 'replace', value: 'not-a-real-secret-value' },
      settings: { sdkType: 'openai' },
    });
    expect(result.draft.providerKey).toBe('live-on-create');
    expect(result.draft.status).toBe('published');
    expect(result.revision).toBe(1);
    expect(JSON.stringify(result)).not.toContain('not-a-real-secret-value');
    // The output carries no publish outcome any more — resolving means it is live.
    expect(result).not.toHaveProperty('published');
    expect(result).not.toHaveProperty('publishError');
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
    const { providerId } = await seedPublishedProvider('reauth-gate');
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
    const { caller, providerId } = await seedPublishedProvider('models-ops');
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
    expect(created.revision).toBeGreaterThan(0);
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
    expect(updated.revision).toBeGreaterThan(0);

    detail = await caller.aiProviders.get({ id: providerId });
    const toggled = await caller.aiModels.applyImmediate({
      enabled: false,
      expectedDraftToken: detail.draftToken,
      modelIds: [extra!.id],
      operation: 'batchToggle',
      providerId,
      reason: 'batch toggle',
    });
    expect(toggled.revision).toBeGreaterThan(0);

    detail = await caller.aiProviders.get({ id: providerId });
    const reorderItems = detail.draft.models.map((m, sort) => ({ id: m.id, sort }));
    const reordered = await caller.aiModels.applyImmediate({
      expectedDraftToken: detail.draftToken,
      items: reorderItems,
      operation: 'reorder',
      providerId,
      reason: 'reorder',
    });
    expect(reordered.revision).toBeGreaterThan(0);

    detail = await caller.aiProviders.get({ id: providerId });
    const deleted = await caller.aiModels.applyImmediate({
      expectedDraftToken: detail.draftToken,
      id: extra!.id,
      operation: 'delete',
      providerId,
      reason: 'delete model',
    });
    expect(deleted.revision).toBeGreaterThan(0);
  });

  it('aiModels.applyImmediate denies model editor without publish permission', async () => {
    const { providerId } = await seedPublishedProvider('models-deny');
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

  /**
   * A never-published (revision 0) provider. applyImmediate always publishes, so this state
   * only exists for legacy drafts written before the draft/publish workflow was removed.
   */
  const seedDeletableProvider = async (providerKey: string) => {
    const caller = await callerFor(ids.aiAdmin);
    const [provider] = await db
      .insert(platformAiProviders)
      .values({
        displayName: providerKey,
        enabled: true,
        providerKey,
        settings: { sdkType: 'openai' },
      })
      .returning();
    await db.insert(platformAiModels).values({
      enabled: true,
      modelKey: 'chat',
      providerId: provider.id,
      type: 'chat',
    });
    await db.insert(platformAiProviderSecrets).values({
      ciphertext: `ciphertext-${providerKey}`,
      fingerprint: `sha256:${providerKey}`,
      keyId: 'legacy',
      keyVersion: 1,
      providerId: provider.id,
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
    const detail = await caller.aiProviders.get({ id: providerId });

    await expect(
      caller.aiProviders.delete({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: providerId,
        reason: 'remove test provider',
      }),
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

  it('hard-deletes an ever-published provider together with its revision history', async () => {
    // Delete is a TRUE delete: an archived tombstone would leave a resource users can still
    // be routed to, and history for something that no longer exists. Afterwards the provider
    // is simply not platform-managed any more.
    const { providerId } = await seedPublishedProvider('delete-published');
    const revisionsBefore = await revisionRows(providerId);
    expect(revisionsBefore.length).toBeGreaterThan(0);

    const caller = await callerFor(ids.aiAdmin);
    const detail = await caller.aiProviders.get({ id: providerId });
    await expect(
      caller.aiProviders.delete({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: providerId,
        reason: 'remove published provider',
      }),
    ).resolves.toEqual({ deleted: true });

    expect(await providerRows(providerId)).toHaveLength(0);
    expect(await modelRows(providerId)).toHaveLength(0);
    expect(await secretRows(providerId)).toHaveLength(0);
    expect(await revisionRows(providerId)).toHaveLength(0);
    const audits = await db.select().from(platformAuditLogs);
    expect(
      audits.some(
        ({ action, result, targetId }) =>
          action === 'admin.aiProviders.delete' && result === 'success' && targetId === providerId,
      ),
    ).toBe(true);
  });

  it('rejects a stale-reauth delete before mutating and records a denied audit', async () => {
    const { caller, providerId } = await seedDeletableProvider('delete-stale-reauth');
    const detail = await caller.aiProviders.get({ id: providerId });
    const stale = await callerFor(ids.aiAdmin, { authenticatedAt: null });

    await expect(
      stale.aiProviders.delete({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: providerId,
        reason: 'stale reauth delete',
      }),
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
    const { caller, providerId } = await seedDeletableProvider('delete-forbidden');
    const detail = await caller.aiProviders.get({ id: providerId });
    const ordinary = await callerFor(ids.normal);

    await expect(
      ordinary.aiProviders.delete({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: providerId,
        reason: 'no permission',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await providerRows(providerId)).toHaveLength(1);
  });
});
