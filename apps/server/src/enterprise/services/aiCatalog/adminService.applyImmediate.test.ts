// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
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

describe('AiCatalogAdminService applyImmediate first-publish retest', () => {
  it('auto retests and publishes on revision 0 when credentials + enabled model exist', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'First',
      enabled: true,
      providerKey: 'first-auto',
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
    detail = await service.getDetail(created.id);
    const result = await service.applyProviderImmediate('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'nudge publish',
    });
    expect(result.published).toBe(true);
    expect(result.revision).toBeGreaterThan(0);
  });

  it('soft-returns published:false when connection test fails on first publish', async () => {
    const service = createService(async () => {
      throw new Error('network down');
    });
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Fail test',
      enabled: true,
      providerKey: 'fail-test',
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
    detail = await service.getDetail(created.id);
    const result = await service.applyProviderImmediate('admin', {
      displayName: 'Still draft',
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'try publish',
    });
    // update mode on revision 0 soft-fails via tryPublish when baseRevision stays 0
    // applyProviderImmediate rethrows for update when baseRevision > 0 only
    expect(result.published).toBe(false);
    // Stable machine-readable code (not free-form probe prose).
    expect(result.publishError).toBe('connection_test_failed');
    expect(result.revision).toBe(0);
  });

  it('does not auto retest cosmetic edits when revision > 0 (allowStaleConnectionTest path)', async () => {
    let probeCount = 0;
    const service = createService(async () => {
      probeCount += 1;
    });
    // Seed published provider
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Live',
      enabled: true,
      providerKey: 'live-p',
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
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'first publish',
    });
    probeCount = 0;
    detail = await service.getDetail(created.id);
    await service.applyProviderImmediate('admin', {
      displayName: 'Renamed live',
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'rename',
    });
    expect(probeCount).toBe(0);
  });

  it('transport config changes (apiStyle/headers/timeoutMs) require retest', async () => {
    let probeCount = 0;
    const service = createService(async () => {
      probeCount += 1;
    });
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      config: { endpoint: 'https://api.example.test/v1' },
      displayName: 'Transport',
      enabled: true,
      providerKey: 'transport-cfg',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai', timeoutMs: 30_000 },
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
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'first publish',
    });
    probeCount = 0;
    detail = await service.getDetail(created.id);
    await service.updateProviderDraft('admin', {
      config: {
        endpoint: 'https://api.example.test/v1',
        headers: { 'X-Custom': '1' },
      },
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'add headers',
      settings: { sdkType: 'openai', timeoutMs: 30_000 },
    });
    detail = await service.getDetail(created.id);
    await expect(
      service.publishProvider('admin', {
        allowStaleConnectionTest: true,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: created.id,
        reason: 'publish headers without retest',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);
    expect(probeCount).toBe(0);

    detail = await service.getDetail(created.id);
    const applied = await service.applyProviderImmediate('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'apply after headers',
    });
    expect(probeCount).toBeGreaterThan(0);
    expect(applied.published).toBe(true);
  });

  it('failed connection probe blocks publish after invalid credentials', async () => {
    const service = createService(async () => {
      throw new Error('invalid_api_key');
    });
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Bad key',
      enabled: true,
      providerKey: 'bad-key-probe',
      reason: 'create',
      secret: { operation: 'replace', value: 'bad-secret' },
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
    const test = await service.testProvider('admin', { id: created.id, reason: 'probe' });
    expect(test.status).toBe('failure');
    detail = await service.getDetail(created.id);
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: created.id,
        reason: 'publish with failed probe',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);
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

  it('refuses hard-delete of ever-published providers so runtime keeps a BYOK tombstone', async () => {
    const secretService = new PlatformSecretService({ keyProvider });
    const service = new AiCatalogAdminService(db, secretService, {
      connectionProbe: async () => {},
    });
    const providerKey = 'published-no-hard-delete';
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Published tombstone',
      enabled: true,
      providerKey,
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
    await service.testProvider('admin', { id: created.id, reason: 'test' });
    detail = await service.getDetail(created.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'publish',
    });
    detail = await service.getDetail(created.id);
    expect(detail.draft.revision).toBeGreaterThan(0);

    // Archive/disable is the supported retirement path; hard-delete must still be rejected.
    await service.archiveProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'archive managed tombstone',
    });
    detail = await service.getDetail(created.id);
    expect(detail.draft.status).toBe('archived');
    expect(detail.draft.revision).toBeGreaterThan(0);

    await expect(
      service.deleteProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: created.id,
        reason: 'hard delete published',
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.stringMatching(/cannot be hard-deleted|archive or disable/i),
      ]),
    });
    await expect(
      service.deleteProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: created.id,
        reason: 'hard delete published',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);

    // Provider row remains so the fail-closed tombstone survives.
    await expect(service.getDetail(created.id)).resolves.toMatchObject({
      draft: { id: created.id, providerKey, revision: expect.any(Number), status: 'archived' },
    });
    expect((await service.getDetail(created.id)).draft.revision).toBeGreaterThan(0);

    // Runtime must fail closed with PROVIDER_DISABLED — never PLATFORM_NOT_FOUND (BYOK signal).
    clearAiCatalogRuntimeCache();
    const execution = new AiCatalogExecutionResolver(db, secretService);
    await expect(execution.resolveProviderExecutionConfig(providerKey)).rejects.toMatchObject({
      code: 'PLATFORM_AI_PROVIDER_DISABLED',
    });
    await expect(execution.resolveProviderExecutionConfig(providerKey)).rejects.not.toMatchObject({
      code: 'PLATFORM_NOT_FOUND',
    });
  });

  it('secret rotation requires retest before publishing (connectivity-sensitive)', async () => {
    let probeCount = 0;
    const service = createService(async () => {
      probeCount += 1;
    });
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Rotate',
      enabled: true,
      providerKey: 'rotate-secret',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key-v1' },
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
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'first publish',
    });
    probeCount = 0;
    detail = await service.getDetail(created.id);
    // Direct publish without retest must fail validation for secret rotation.
    await service.updateProviderDraft('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'rotate secret',
      secret: { operation: 'replace', value: 'seed-key-v2-invalid' },
    });
    detail = await service.getDetail(created.id);
    await expect(
      service.publishProvider('admin', {
        allowStaleConnectionTest: true,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: created.id,
        reason: 'publish rotated secret without retest',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);
    expect(probeCount).toBe(0);

    // applyImmediate must auto-retest then publish.
    detail = await service.getDetail(created.id);
    const applied = await service.applyProviderImmediate('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'apply after rotate',
    });
    expect(probeCount).toBeGreaterThan(0);
    expect(applied.published).toBe(true);
  });

  it('publishNow retests revision 0 and publishes', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Now',
      enabled: true,
      providerKey: 'publish-now',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    const detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'model',
      type: 'chat',
    });
    const result = await service.publishNow('admin', {
      id: created.id,
      reason: 'banner retry',
    });
    expect(result.published).toBe(true);
    expect(result.revision).toBeGreaterThan(0);
  });

  it('applyModelImmediate create then publishes with auto retest on revision 0', async () => {
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
    expect(result.published).toBe(true);
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
    expect(off.published).toBe(true);
    expect(off.draft.enabled).toBe(false);
    expect(off.revision).toBeGreaterThan(first.revision);

    // Runtime materialization must exclude published-disabled providers.
    clearAiCatalogRuntimeCache();
    const runtime = await new AiCatalogRuntimeAdapter(db).resolve({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
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
    expect(on.published).toBe(true);
    expect(on.draft.enabled).toBe(true);

    clearAiCatalogRuntimeCache();
    const runtimeOn = await new AiCatalogRuntimeAdapter(db).resolve({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
      upstreamState: getEmptyAiProviderRuntimeState(),
    });
    expect(runtimeOn.enabledAiProviders.map((p) => p.id)).toContain('disable-pub');
  });

  it('revision 0 disable publish is still rejected (first publish must be enabled)', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      displayName: 'Never Live',
      enabled: false,
      providerKey: 'rev0-off',
      reason: 'create disabled',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    const detail = await service.getDetail(created.id);
    const result = await service.applyProviderImmediate('admin', {
      enabled: false,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'cannot first-publish disabled',
    });
    // Soft path on revision 0: draft kept, not published.
    expect(result.published).toBe(false);
    expect(result.revision).toBe(0);
  });

  /**
   * R2 "update failure visibility" — rewritten after F1 semantic change:
   * disable is now a valid publish; use invalid endpoint on a still-enabled
   * published provider so publish validation still throws (not soft-return).
   */
  it('update on published provider throws when publish validation fails (not soft-return)', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Throwing',
      enabled: true,
      providerKey: 'throw-pub',
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
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'first publish',
    });
    detail = await service.getDetail(created.id);
    await expect(
      service.applyProviderImmediate('admin', {
        config: { endpoint: 'not-a-valid-url' },
        enabled: true,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: created.id,
        mode: 'update',
        reason: 'invalid endpoint must throw',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);
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
