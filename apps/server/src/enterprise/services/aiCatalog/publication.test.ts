// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAgents,
  platformAiModels,
  platformAiProviders,
  platformAuditLogs,
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import {
  AiCatalogAdminService,
  type AiCatalogAdminServiceOptions,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from './adminService';
import { AiCatalogReadService } from './catalogReadService';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(31), keyId: 'publish-test' }),
  providerId: 'test',
};

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformAgents);
  await db.delete(platformAiModels);
  await db.delete(platformAiProviders);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

const createService = (lifecycle?: AiCatalogAdminServiceOptions['lifecycle']) => {
  const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
  return {
    invalidation,
    service: new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
      connectionProbe: async () => {},
      invalidation,
      lifecycle,
    }),
  };
};

describe('AiCatalog publication transaction', () => {
  it('requires a successful connection test bound to the current draft', async () => {
    const { service } = createService();
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Connection gated',
      enabled: true,
      providerKey: 'connection-gated',
      reason: 'create',
      secret: { operation: 'replace', value: 'fake-key' },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    const model = await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'model',
    });
    detail = await service.getDetail(provider.id);
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'untested publish',
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        'Current provider draft must pass connection testing before publish',
      ]),
    });

    await service.testProvider('admin', { id: provider.id, reason: 'test' });
    detail = await service.getDetail(provider.id);
    await service.updateModel('admin', {
      displayName: 'changed after test',
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: model.id,
      providerId: provider.id,
      reason: 'mutate',
    });
    detail = await service.getDetail(provider.id);
    expect(detail.draft.connectionTest?.stale).toBe(true);
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'stale test publish',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);

    await service.testProvider('admin', { id: provider.id, reason: 'retest' });
    detail = await service.getDetail(provider.id);
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'tested publish',
      }),
    ).resolves.toMatchObject({ revision: 1 });
    expect((await service.getDetail(provider.id)).draft.connectionTest).toMatchObject({
      stale: false,
      status: 'success',
      testedRevision: 1,
    });
  });

  it('validation failure leaves the current published revision unchanged', async () => {
    const { service } = createService();
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Invalid',
      enabled: true,
      providerKey: 'invalid',
      reason: 'create',
      secret: { operation: 'replace', value: 'fake-key' },
      source: 'custom',
    });
    const detail = await service.getDetail(provider.id);
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'must fail without models',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(0);
    expect((await service.getDetail(provider.id)).baseRevision).toBe(0);
  });

  it('publishes a chat-ready provider backed only by the ModelRuntime environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'environment-only-key');
    const { service } = createService();
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Environment provider',
      enabled: true,
      providerKey: 'environment-provider',
      reason: 'create',
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'model',
      type: 'chat',
    });
    await expect(
      service.testProvider('admin', { id: provider.id, reason: 'environment readiness' }),
    ).resolves.toMatchObject({ status: 'success' });
    detail = await service.getDetail(provider.id);
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'publish environment provider',
      }),
    ).resolves.toMatchObject({ revision: 1 });
    expect((await service.getDetail(provider.id)).published?.providerKey).toBe(
      'environment-provider',
    );
  });

  it('rechecks archive dependents after the provider lock before committing', async () => {
    const { service } = createService();
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Concurrent dependency provider',
      enabled: true,
      providerKey: 'concurrent-provider',
      reason: 'create',
      secret: { operation: 'replace', value: 'fake-key' },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'model',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: provider.id,
      reason: 'publish',
    });

    detail = await service.getDetail(provider.id);
    const archiveService = createService({
      afterPublishLock: async (tx) => {
        await tx.insert(platformAgents).values({
          agentKey: 'concurrent-agent',
          model: 'chat',
          provider: 'concurrent-provider',
          status: 'published',
          title: 'Concurrent Agent',
        });
      },
    }).service;
    await expect(
      archiveService.archiveProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 1,
        id: provider.id,
        reason: 'archive after dependency insertion',
      }),
    ).rejects.toBeInstanceOf(AiCatalogResourceInUseError);

    expect(await db.select().from(platformResourceRevisions)).toHaveLength(1);
    expect((await service.getDetail(provider.id)).published).toMatchObject({ revision: 1 });
  });

  it('publishes atomically, preserves numeric token limits, rolls back, archives and invalidates', async () => {
    const { invalidation, service } = createService();
    const credential = 'publication-plain-credential-value';
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      config: { endpoint: 'https://api.example.test/v1' },
      displayName: 'Alpha',
      enabled: true,
      providerKey: 'alpha',
      reason: 'create',
      secret: { operation: 'replace', value: credential },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    const model = await service.createModel('admin', {
      contextWindowTokens: 128_000,
      displayName: 'Version One',
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      parameters: { maxTokens: 4096 },
      providerId: provider.id,
      reason: 'add model',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test v1' });
    detail = await service.getDetail(provider.id);
    const first = await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: provider.id,
      reason: `publish v1 ${credential}`,
    });
    expect(first.revision).toBe(1);
    const [revisionOne] = await db.select().from(platformResourceRevisions);
    expect(revisionOne.payload).toMatchObject({
      models: [{ contextWindowTokens: 128_000, parameters: { maxTokens: 4096 } }],
    });
    expect(JSON.stringify(revisionOne)).not.toContain(credential);
    expect((await new AiCatalogReadService(db).getPublished()).providers[0]).toMatchObject({
      models: [{ contextWindowTokens: 128_000, modelKey: 'chat' }],
      providerKey: 'alpha',
      revision: 1,
    });

    detail = await service.getDetail(provider.id);
    await service.updateModel('admin', {
      displayName: 'Version Two',
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: model.id,
      providerId: provider.id,
      reason: 'edit model',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test v2' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'publish v2',
    });
    expect((await service.getDetail(provider.id)).published?.models[0].displayName).toBe(
      'Version Two',
    );
    const history = await service.listRevisionHistory({ id: provider.id, limit: 10 });
    expect(history.items.map((item) => item.revision)).toEqual([2, 1]);
    expect(history.items[0]).toEqual(
      expect.objectContaining({ checksum: expect.any(String), status: 'published' }),
    );
    expect(history.items[0]).not.toHaveProperty('payload');
    expect(history.items[0]).not.toHaveProperty('secretFingerprint');

    detail = await service.getDetail(provider.id);
    const rolled = await service.rollbackProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 2,
      id: provider.id,
      reason: 'rollback to v1',
      targetRevision: 1,
    });
    expect(rolled.revision).toBe(3);
    expect((await service.getDetail(provider.id)).draft.models[0].displayName).toBe('Version One');
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(3);

    detail = await service.getDetail(provider.id);
    const archived = await service.archiveProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 3,
      id: provider.id,
      reason: 'archive',
    });
    expect(archived.revision).toBe(4);
    expect((await new AiCatalogReadService(db).getPublished()).providers).toEqual([]);
    expect(invalidation.events).toHaveLength(4);
    expect(invalidation.events.every((event) => event.scopes?.includes('ai-catalog'))).toBe(true);

    detail = await service.getDetail(provider.id);
    await expect(
      service.rollbackProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 4,
        id: provider.id,
        reason: 'archived revisions are not rollback targets',
        targetRevision: 4,
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(4);
  });
});
