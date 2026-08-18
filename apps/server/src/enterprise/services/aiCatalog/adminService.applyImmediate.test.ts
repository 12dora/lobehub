// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService, AiCatalogValidationError } from './adminService';
import {
  AiCatalogExecutionResolver,
  AiCatalogRuntimeAdapter,
  clearAiCatalogRuntimeCache,
  getEmptyAiProviderRuntimeState,
} from './runtimeAdapter';
import { resolveAiCatalogRuntimeReadiness } from './runtimeReadiness';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(41), keyId: 'apply-imm' }),
  providerId: 'test',
};

/** Append-only audit rows cannot be DELETE'd (0145); TRUNCATE bypasses the row trigger. */
const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformSettingPolicies},
      ${platformAiModels},
      ${platformAiProviderSecrets},
      ${platformAiProviders}
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
});
afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const createService = (connectionProbe: () => Promise<void> = async () => {}) =>
  new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
    connectionProbe,
  });

describe('AiCatalogAdminService applyImmediate (unconditional publish)', () => {
  it('publishes a create with zero models and no credentials, without probing', async () => {
    let probeCount = 0;
    const service = createService(async () => {
      probeCount += 1;
    });
    const result = await service.applyProviderImmediate('admin', {
      displayName: 'Bare',
      enabled: true,
      mode: 'create',
      providerKey: 'bare-create',
      reason: 'create and go live',
      settings: { sdkType: 'openai' },
      source: 'custom',
    });
    // Readiness is no longer a publish gate: no models, no secret, no connection test.
    expect(result.revision).toBe(1);
    expect(result.draft.models).toEqual([]);
    expect(result.draft.secret.configured).toBe(false);
    expect(result.auditId).toEqual(expect.any(String));
    expect(probeCount).toBe(0);

    const detail = await service.getDetail(result.draft.id);
    expect(detail.baseRevision).toBe(1);
    expect(detail.draft.status).toBe('published');
    // The revision is live; the public catalog projection stays empty until a model is
    // enabled (nothing to expose), which is exactly the user-side provider behaviour.
    expect(detail.published).toBeNull();

    // No stored secret and not env/endpoint-executable → providers stay unready.
    clearAiCatalogRuntimeCache();
    await expect(
      resolveAiCatalogRuntimeReadiness({
        db,
        flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
        secretService: new PlatformSecretService({ keyProvider }),
      }),
    ).resolves.toEqual({ aiModels: false, aiProviders: false });
  });

  it('marks providers ready (and models not) after applyImmediate with a secret and no chat model', async () => {
    const secretService = new PlatformSecretService({ keyProvider });
    const service = new AiCatalogAdminService(db, secretService, {
      connectionProbe: async () => {},
    });
    const created = await service.applyProviderImmediate('admin', {
      displayName: 'Secret only',
      enabled: true,
      mode: 'create',
      providerKey: 'secret-ready-no-model',
      reason: 'create with secret',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
      source: 'custom',
    });
    expect(created.revision).toBe(1);
    expect(created.draft.models).toEqual([]);
    expect(created.draft.secret.configured).toBe(true);

    clearAiCatalogRuntimeCache();
    const flags = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true };
    await expect(resolveAiCatalogRuntimeReadiness({ db, flags, secretService })).resolves.toEqual({
      aiModels: false,
      aiProviders: true,
    });

    const detail = await service.getDetail(created.draft.id);
    await service.applyModelImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      operation: 'create',
      providerId: created.draft.id,
      reason: 'enable chat',
      type: 'chat',
    });
    clearAiCatalogRuntimeCache();
    await expect(resolveAiCatalogRuntimeReadiness({ db, flags, secretService })).resolves.toEqual({
      aiModels: true,
      aiProviders: true,
    });
  });

  it('republishes an update without re-running the connection test', async () => {
    let probeCount = 0;
    const service = createService(async () => {
      probeCount += 1;
    });
    const created = await service.applyProviderImmediate('admin', {
      displayName: 'Live',
      enabled: true,
      mode: 'create',
      providerKey: 'live-republish',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
      source: 'custom',
    });
    const detail = await service.getDetail(created.draft.id);
    // Connectivity-sensitive change (secret rotation) — still no probe, still publishes.
    const renamed = await service.applyProviderImmediate('admin', {
      displayName: 'Live Renamed',
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.draft.id,
      mode: 'update',
      reason: 'rotate + rename',
      secret: { operation: 'replace', value: 'seed-key-v2' },
    });
    expect(renamed.draft.displayName).toBe('Live Renamed');
    expect(renamed.revision).toBe(created.revision + 1);
    expect(probeCount).toBe(0);
  });

  it('throws instead of leaving an unpublished draft when publish validation fails', async () => {
    const service = createService(async () => {});
    const created = await service.applyProviderImmediate('admin', {
      displayName: 'Throwing',
      enabled: true,
      mode: 'create',
      providerKey: 'throw-pub',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
      source: 'custom',
    });
    const detail = await service.getDetail(created.draft.id);
    await expect(
      service.applyProviderImmediate('admin', {
        config: { endpoint: 'not-a-valid-url' },
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: created.draft.id,
        mode: 'update',
        reason: 'invalid endpoint must throw',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);
    // Atomic: neither the draft write nor the pointer moved.
    const unchanged = await service.getDetail(created.draft.id);
    expect(unchanged.baseRevision).toBe(created.revision);
    expect(unchanged.draft.config).toEqual({});
    expect(unchanged.draft.status).toBe('published');
  });

  it('throws on a create whose first publish is invalid (no soft-fail draft)', async () => {
    const service = createService(async () => {});
    await expect(
      service.applyProviderImmediate('admin', {
        config: { endpoint: 'ftp://example.test' },
        displayName: 'Bad endpoint',
        enabled: true,
        mode: 'create',
        providerKey: 'bad-endpoint-create',
        reason: 'create with unusable endpoint',
        settings: { sdkType: 'openai' },
        source: 'custom',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);
    // Atomic: the draft write rolled back with the failed publish, so a retry cannot
    // collide with a half-created provider.
    expect(
      await db
        .select()
        .from(platformAiProviders)
        .where(eq(platformAiProviders.providerKey, 'bad-endpoint-create')),
    ).toEqual([]);
  });

  it('rolls the model mutation back when the parent publish fails', async () => {
    const service = createService(async () => {});
    const created = await service.applyProviderImmediate('admin', {
      displayName: 'Model atomic',
      enabled: true,
      mode: 'create',
      providerKey: 'model-atomic',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
      source: 'custom',
    });
    // Poison the provider so publish validation fails AFTER the model DML has run.
    await db
      .update(platformAiProviders)
      .set({ config: { endpoint: 'not-a-valid-url' } })
      .where(eq(platformAiProviders.id, created.draft.id));

    const detail = await service.getDetail(created.draft.id);
    await expect(
      service.applyModelImmediate('admin', {
        enabled: true,
        expectedDraftToken: detail.draftToken,
        modelKey: 'rolled-back',
        operation: 'create',
        providerId: created.draft.id,
        reason: 'model create with failing publish',
        type: 'chat',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);

    const after = await service.getDetail(created.draft.id);
    expect(after.draft.models).toEqual([]);
    expect(after.baseRevision).toBe(created.revision);
  });

  it('hard-delete requires matching expectedRevision and expectedDraftToken', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      displayName: 'Delete me',
      enabled: true,
      providerKey: 'delete-cas',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    const detail = await service.getDetail(created.id);

    await expect(
      service.deleteProvider('admin', {
        expectedDraftToken: '0'.repeat(64),
        expectedRevision: detail.draft.revision,
        id: created.id,
        reason: 'stale draft token',
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_REVISION_CONFLICT' });

    await expect(
      service.deleteProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.draft.revision + 1,
        id: created.id,
        reason: 'stale revision',
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_REVISION_CONFLICT' });

    await service.deleteProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.draft.revision,
      id: created.id,
      reason: 'hard delete',
    });
    await expect(service.getDetail(created.id)).rejects.toMatchObject({
      code: 'PLATFORM_NOT_FOUND',
    });
  });

  it('hard-deletes a published provider completely and hands it back to BYOK', async () => {
    const secretService = new PlatformSecretService({ keyProvider });
    const service = new AiCatalogAdminService(db, secretService, {
      connectionProbe: async () => {},
    });
    const providerKey = 'published-hard-delete';
    const created = await service.applyProviderImmediate('admin', {
      displayName: 'Published then removed',
      enabled: true,
      mode: 'create',
      providerKey,
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
      source: 'custom',
    });
    const providerId = created.draft.id;
    let detail = await service.getDetail(providerId);
    await service.applyModelImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      operation: 'create',
      providerId,
      reason: 'model',
      type: 'chat',
    });
    detail = await service.getDetail(providerId);
    expect(detail.baseRevision).toBeGreaterThan(0);

    // An operation already in flight pinned this exact revision.
    const [pinned] = await db
      .select()
      .from(platformResourceRevisions)
      .where(eq(platformResourceRevisions.resourceId, providerId));
    const pinnedRef = {
      modelKey: 'chat',
      providerChecksum: pinned.checksum!,
      providerKey,
      providerRevision: pinned.revision,
    };

    await expect(
      service.deleteProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: providerId,
        reason: 'remove the provider for good',
      }),
    ).resolves.toEqual({ deleted: true });

    // Nothing of the provider survives — not even its immutable revision history.
    expect(
      await db.select().from(platformAiProviders).where(eq(platformAiProviders.id, providerId)),
    ).toEqual([]);
    expect(
      await db.select().from(platformAiModels).where(eq(platformAiModels.providerId, providerId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(platformAiProviderSecrets)
        .where(eq(platformAiProviderSecrets.providerId, providerId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(platformResourceRevisions)
        .where(eq(platformResourceRevisions.resourceId, providerId)),
    ).toEqual([]);

    // Runtime: as if never platform-managed → NOT_FOUND, which is what the ModelRuntime
    // bridge treats as "fall back to the user's own BYOK configuration".
    clearAiCatalogRuntimeCache();
    const execution = new AiCatalogExecutionResolver(db, secretService);
    await expect(execution.resolveProviderExecutionConfig(providerKey)).rejects.toMatchObject({
      code: 'PLATFORM_NOT_FOUND',
    });
    const runtime = await new AiCatalogRuntimeAdapter(db).resolve({
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
      upstreamState: getEmptyAiProviderRuntimeState(),
    });
    expect(runtime.enabledAiProviders.map((provider) => provider.id)).not.toContain(providerKey);

    // In-flight pinned operations fail closed with a labelled provider error (never an
    // opaque internal error, and never silently re-pointed at another configuration).
    await expect(
      execution.resolveProviderExecutionConfigAtRevision(pinnedRef),
    ).rejects.toMatchObject({
      code: 'PLATFORM_AI_PROVIDER_DISABLED',
      errorType: 'PLATFORM_AI_PROVIDER_DISABLED',
    });
  });

  it('applyModelImmediate create publishes the parent provider immediately', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Models',
      enabled: true,
      providerKey: 'models-p',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    const detail = await service.getDetail(created.id);
    const result = await service.applyModelImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      operation: 'create',
      providerId: created.id,
      reason: 'add model',
      type: 'chat',
    });
    expect(result.revision).toBeGreaterThan(0);
  });

  it('batchToggle failure rolls back prior items (atomic batch)', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat-a',
      displayName: 'Batch',
      enabled: true,
      providerKey: 'batch-atomic',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    let detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat-a',
      providerId: created.id,
      reason: 'model a',
      type: 'chat',
    });
    detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat-b',
      providerId: created.id,
      reason: 'model b',
      type: 'chat',
    });
    await service.testProvider('admin', { id: created.id, reason: 'prime' });
    detail = await service.getDetail(created.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'publish',
    });
    detail = await service.getDetail(created.id);
    const models = detail.draft.models;
    expect(models).toHaveLength(2);
    const firstId = models[0]!.id;
    const beforeEnabled = models.map((m) => m.enabled);

    // Second id is unknown → mid-batch failure; first toggle must not stick.
    await expect(
      service.applyModelImmediate('admin', {
        enabled: false,
        expectedDraftToken: detail.draftToken,
        modelIds: [firstId, 'missing-model-id'],
        operation: 'batchToggle',
        providerId: created.id,
        reason: 'atomic batch',
      }),
    ).rejects.toBeTruthy();

    const after = await service.getDetail(created.id);
    expect(after.draft.models.map((m) => m.enabled)).toEqual(beforeEnabled);
  });

  it('batchUpdate failure rolls back prior items (atomic batch)', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat-a',
      displayName: 'Batch Update',
      enabled: true,
      providerKey: 'batch-update-atomic',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key-for-leak-check' },
      settings: { sdkType: 'openai' },
    });
    let detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat-a',
      providerId: created.id,
      reason: 'model a',
      type: 'chat',
    });
    detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat-b',
      providerId: created.id,
      reason: 'model b',
      type: 'chat',
    });
    await service.testProvider('admin', { id: created.id, reason: 'prime' });
    detail = await service.getDetail(created.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'publish',
    });
    detail = await service.getDetail(created.id);
    const [first, second] = detail.draft.models;
    expect(first && second).toBeTruthy();
    const beforeNames = detail.draft.models.map((m) => m.displayName);

    // Second update embeds the live secret → credential boundary fails mid-batch.
    await expect(
      service.applyModelImmediate('admin', {
        expectedDraftToken: detail.draftToken,
        models: [
          { displayName: 'Renamed A', id: first!.id },
          {
            description: 'contains seed-key-for-leak-check',
            displayName: 'Renamed B',
            id: second!.id,
          },
        ],
        operation: 'batchUpdate',
        providerId: created.id,
        reason: 'atomic batch update',
      }),
    ).rejects.toBeTruthy();

    const after = await service.getDetail(created.id);
    expect(after.draft.models.map((m) => m.displayName)).toEqual(beforeNames);
  });

  it('clear failure rolls back prior model deletes (atomic batch)', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat-a',
      displayName: 'Batch Clear',
      enabled: true,
      providerKey: 'batch-clear-atomic',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    let detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat-a',
      providerId: created.id,
      reason: 'model a',
      type: 'chat',
    });
    detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat-b',
      providerId: created.id,
      reason: 'model b',
      type: 'chat',
    });
    await service.testProvider('admin', { id: created.id, reason: 'prime' });
    detail = await service.getDetail(created.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'publish',
    });

    detail = await service.getDetail(created.id);
    expect(detail.draft.models).toHaveLength(2);
    // Block the second model in draft order so the first delete succeeds then rolls back.
    const blockedModelKey = detail.draft.models[1]!.modelKey;
    await db.insert(platformSettingPolicies).values([
      {
        mode: 'default',
        path: 'systemAgent.topic.provider',
        revision: 1,
        schemaVersion: 1,
        status: 'published',
        value: 'batch-clear-atomic',
        visibility: 'visible',
      },
      {
        mode: 'default',
        path: 'systemAgent.topic.model',
        revision: 1,
        schemaVersion: 1,
        status: 'published',
        value: blockedModelKey,
        visibility: 'visible',
      },
    ]);

    const beforeKeys = detail.draft.models.map((m) => m.modelKey).sort();
    await expect(
      service.applyModelImmediate('admin', {
        expectedDraftToken: detail.draftToken,
        operation: 'clear',
        providerId: created.id,
        reason: 'atomic clear',
      }),
    ).rejects.toBeTruthy();

    const after = await service.getDetail(created.id);
    expect(after.draft.models.map((m) => m.modelKey).sort()).toEqual(beforeKeys);
  });

  it('toggle-off published provider publishes enabled:false revision (global disable)', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Disable Me',
      enabled: true,
      providerKey: 'disable-pub',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    let detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: created.id, reason: 'prime' });
    detail = await service.getDetail(created.id);
    const first = await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'first publish',
    });
    detail = await service.getDetail(created.id);
    const off = await service.applyProviderImmediate('admin', {
      enabled: false,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'global disable',
    });
    expect(off.draft.enabled).toBe(false);
    expect(off.revision).toBeGreaterThan(first.revision);

    // Runtime materialization must exclude published-disabled providers.
    clearAiCatalogRuntimeCache();
    const runtime = await new AiCatalogRuntimeAdapter(db).resolve({
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
      upstreamState: getEmptyAiProviderRuntimeState(),
    });
    expect(runtime.enabledAiProviders.map((p) => p.id)).not.toContain('disable-pub');
    expect(runtime.enabledAiModels.every((m) => m.providerId !== 'disable-pub')).toBe(true);

    // OFF → ON recovers without extra obstacles (stale connection test allowed).
    detail = await service.getDetail(created.id);
    const on = await service.applyProviderImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 're-enable',
    });
    expect(on.draft.enabled).toBe(true);

    clearAiCatalogRuntimeCache();
    const runtimeOn = await new AiCatalogRuntimeAdapter(db).resolve({
      flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
      upstreamState: getEmptyAiProviderRuntimeState(),
    });
    expect(runtimeOn.enabledAiProviders.map((p) => p.id)).toContain('disable-pub');
  });

  it('resurrects an archived builtin provider through a later applyImmediate update', async () => {
    // Settings-page "delete" is a hard delete; archive survives only as a server-side
    // retirement path. Either way, re-enabling the same builtin providerKey must republish it
    // and put it back into the runtime snapshot.
    const providerKey = 'openai';
    const service = createService(async () => {});
    const created = await service.applyProviderImmediate('admin', {
      displayName: 'OpenAI',
      enabled: true,
      mode: 'create',
      providerKey,
      reason: 'enable builtin provider',
      secret: { operation: 'replace', value: { apiKey: 'builtin-seed-key' } },
      source: 'builtin',
    });
    let detail = await service.getDetail(created.draft.id);
    await service.applyModelImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'gpt-test',
      operation: 'create',
      providerId: created.draft.id,
      reason: 'add model',
      type: 'chat',
    });

    const runtimeProviders = async () => {
      clearAiCatalogRuntimeCache();
      const runtime = await new AiCatalogRuntimeAdapter(db).resolve({
        flags: { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
        upstreamState: getEmptyAiProviderRuntimeState(),
      });
      return runtime.enabledAiProviders.map((provider) => provider.id);
    };
    expect(await runtimeProviders()).toContain(providerKey);

    detail = await service.getDetail(created.draft.id);
    await service.archiveProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.draft.id,
      reason: 'remove from settings page',
    });
    expect((await service.getDetail(created.draft.id)).draft.status).toBe('archived');
    expect(await runtimeProviders()).not.toContain(providerKey);
    clearAiCatalogRuntimeCache();
    // Platform takeover applies only while enabled: an archived provider reports NOT_FOUND
    // so ModelRuntime falls back to the user's own BYOK configuration.
    await expect(
      new AiCatalogExecutionResolver(
        db,
        new PlatformSecretService({ keyProvider }),
      ).resolveProviderExecutionConfig(providerKey),
    ).rejects.toMatchObject({ code: 'PLATFORM_NOT_FOUND' });

    detail = await service.getDetail(created.draft.id);
    const resurrected = await service.applyProviderImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.draft.id,
      mode: 'update',
      reason: 're-enable archived builtin',
    });
    expect(resurrected.draft.status).toBe('published');
    expect(resurrected.revision).toBeGreaterThan(detail.baseRevision);
    expect(await runtimeProviders()).toContain(providerKey);
  });

  it('secret merge keeps unsubmitted apiKey when only baseURL-equivalent fields are absent', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      displayName: 'Merge',
      enabled: true,
      providerKey: 'merge-p',
      reason: 'create',
      secret: { operation: 'replace', value: { apiKey: 'keep-key' } },
      settings: { sdkType: 'openai' },
    });
    const detail = await service.getDetail(created.id);
    // Empty merge payload fields are ignored — vault apiKey retained.
    await service.updateProviderDraft('admin', {
      config: { endpoint: 'https://public.endpoint' },
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'public endpoint only',
      secret: { operation: 'merge', value: { apiKey: '' } },
    });
    const [row] = await db
      .select()
      .from(platformAiProviders)
      .where(eq(platformAiProviders.id, created.id));
    const secrets = new PlatformSecretService({ keyProvider });
    const vault = JSON.parse(await secrets.decrypt(row.encryptedKeyVaults!));
    expect(vault).toEqual({ apiKey: 'keep-key' });
    expect(row.config).toMatchObject({ endpoint: 'https://public.endpoint' });
  });
});
