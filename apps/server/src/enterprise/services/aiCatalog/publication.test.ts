// @vitest-environment node
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAiCatalogDraftToken, PlatformAiCatalogModel } from '@/database/models/platform';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import {
  platformAgents,
  platformAgentVersions,
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase, Transaction } from '@/database/type';
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
const AGENT_DEPENDENCY_CHECKSUM = 'c'.repeat(64);
const agentConfig = {
  avatar: null,
  backgroundColor: null,
  description: 'Exact AI publication dependent',
  displayName: 'Exact AI publication dependent',
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Use the exact model dependency.',
  tags: [],
};

const createPublishedAgentDependency = async (
  source: LobeChatDatabase | Transaction,
  params: { agentKey: string; modelKey: string; providerKey: string },
) => {
  const repository = new PlatformAgentCatalogRepository(source);
  const agent = await repository.createIdentity({
    agentKey: params.agentKey,
    isDefault: false,
    systemKey: null,
  });
  const version = await repository.appendVersionCas({
    agentId: agent.id,
    config: agentConfig,
    dependencySnapshot: {
      connectors: [],
      model: {
        modelKey: params.modelKey,
        providerChecksum: AGENT_DEPENDENCY_CHECKSUM,
        providerKey: params.providerKey,
        providerRevision: 1,
      },
      skills: [],
    },
    expectedDraftSequence: 0,
    expectedRevision: 0,
    version: '1.0.0',
  });
  await repository.pointToVersionCas({
    agentId: agent.id,
    expectedDraftSequence: 1,
    expectedRevision: 0,
    publishedAt: new Date(),
    versionId: version!.id,
  });
  await source
    .update(platformAgents)
    .set({ model: 'legacy-poison-model', provider: 'legacy-poison-provider' })
    .where(eq(platformAgents.id, agent.id));
  return agent;
};

/** Append-only audit rows cannot be DELETE'd (0145); TRUNCATE bypasses the row trigger. */
const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformAgentVersions},
      ${platformAgents},
      ${platformAiModels},
      ${platformAiProviders}
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

const createService = (
  lifecycle?: AiCatalogAdminServiceOptions['lifecycle'],
  resolveDependentsForModels?: AiCatalogAdminServiceOptions['resolveDependentsForModels'],
) => {
  const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
  return {
    invalidation,
    service: new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
      connectionProbe: async () => {},
      invalidation,
      lifecycle,
      resolveDependentsForModels,
    }),
  };
};

describe('AiCatalog publication transaction', () => {
  it('can disable a published provider without decrypting its stored Secret', async () => {
    const { service } = createService();
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Emergency disable',
      enabled: true,
      providerKey: 'emergency-disable',
      reason: 'create',
      secret: { operation: 'replace', value: 'emergency-disable-key' },
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
    await service.testProvider('admin', { id: provider.id, reason: 'test' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: provider.id,
      reason: 'publish',
    });
    detail = await service.getDetail(provider.id);
    await service.updateProviderDraft('admin', {
      enabled: false,
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'prepare emergency disable',
    });
    await db
      .update(platformAiProviders)
      .set({ encryptedKeyVaults: 'unreadable-envelope' })
      .where(eq(platformAiProviders.id, provider.id));
    await db
      .update(platformAiProviderSecrets)
      .set({ ciphertext: 'unreadable-envelope' })
      .where(eq(platformAiProviderSecrets.providerId, provider.id));
    detail = await service.getDetail(provider.id);
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 1,
        id: provider.id,
        reason: 'disable during key outage',
      }),
    ).resolves.toMatchObject({ revision: 2 });
    const [disabled] = await db
      .select({
        enabled: platformAiProviders.enabled,
        providerKey: platformAiProviders.providerKey,
        revision: platformAiProviders.revision,
        status: platformAiProviders.status,
      })
      .from(platformAiProviders)
      .where(eq(platformAiProviders.id, provider.id));
    expect(disabled).toMatchObject({
      enabled: false,
      providerKey: 'emergency-disable',
      revision: 2,
      status: 'published',
    });
  });

  it('publishes without any connection test and rebinds the probe to the new revision', async () => {
    const { service } = createService();
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Connection ungated',
      enabled: true,
      providerKey: 'connection-ungated',
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
    // Never probed: readiness is not a publish gate.
    expect(detail.draft.connectionTest).toBeNull();
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'untested publish',
      }),
    ).resolves.toMatchObject({ revision: 1 });

    // A stale probe result is equally irrelevant.
    await service.testProvider('admin', { id: provider.id, reason: 'test' });
    detail = await service.getDetail(provider.id);
    await service.updateModel('admin', {
      displayName: 'changed after test',
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: model.id,
      providerId: provider.id,
      reason: 'mutate',
    });
    detail = await service.getDetail(provider.id);
    expect(detail.draft.connectionTest?.stale).toBe(true);
    await db
      .update(platformAiProviderSecrets)
      .set({ keyId: null })
      .where(eq(platformAiProviderSecrets.providerId, provider.id));
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 1,
        id: provider.id,
        reason: 'stale test publish',
      }),
    ).resolves.toMatchObject({ revision: 2 });
    const [materialized] = await db
      .select()
      .from(platformAiProviders)
      .where(eq(platformAiProviders.id, provider.id));
    expect(materialized.secretKeyId).toBe('publish-test');
    // Publish rebinds the successful probe to the freshly published revision.
    expect((await service.getDetail(provider.id)).draft.connectionTest).toMatchObject({
      stale: false,
      status: 'success',
      testedRevision: 2,
    });
  });

  it('security validation failure leaves the current published revision unchanged', async () => {
    const { service } = createService();
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Invalid',
      enabled: true,
      fetchOnClient: true,
      providerKey: 'invalid',
      reason: 'create',
      secret: { operation: 'replace', value: 'fake-key' },
      source: 'custom',
    });
    const detail = await service.getDetail(provider.id);
    // A credential-bearing provider must never delegate the request to the browser.
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'must fail on fetchOnClient with a secret',
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining(['Secret-configured providers must disable fetchOnClient']),
    });
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(0);
    expect((await service.getDetail(provider.id)).baseRevision).toBe(0);
  });

  it('fires invalidation only after the applyImmediate transaction commits', async () => {
    // Late failure inside the apply transaction: the publish savepoint already committed, so
    // an eagerly-fired event would advertise a revision that the rollback then erases.
    const failing = createService({
      afterApplyPublish: async () => {
        throw new Error('outer transaction fails after publish');
      },
    });
    await expect(
      failing.service.applyProviderImmediate('admin', {
        displayName: 'Never announced',
        enabled: true,
        mode: 'create',
        providerKey: 'never-announced',
        reason: 'create',
        source: 'custom',
      }),
    ).rejects.toThrow('outer transaction fails after publish');
    expect(failing.invalidation.events).toEqual([]);
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(0);
    expect(await db.select().from(platformAiProviders)).toHaveLength(0);

    const { invalidation, service } = createService();
    const created = await service.applyProviderImmediate('admin', {
      displayName: 'Announced once',
      enabled: true,
      mode: 'create',
      providerKey: 'announced-once',
      reason: 'create',
      source: 'custom',
    });
    expect(created.revision).toBe(1);
    expect(invalidation.events).toHaveLength(1);
    expect(invalidation.events[0]).toMatchObject({ resourceType: 'provider', revision: 1 });
  });

  it('publishes a provider with no models and no credentials at all', async () => {
    const { service } = createService();
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Bare',
      enabled: true,
      providerKey: 'bare-publish',
      reason: 'create',
      source: 'custom',
    });
    const detail = await service.getDetail(provider.id);
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: provider.id,
        reason: 'publish an empty provider',
      }),
    ).resolves.toMatchObject({ revision: 1 });
    // Live revision, but nothing to expose publicly until a model is enabled.
    expect((await new AiCatalogReadService(db).getPublished()).providers).toEqual([]);
  });

  it('publishes a disabled provider so a toggle-off persists site-wide', async () => {
    const { service } = createService();
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Never enabled',
      enabled: false,
      providerKey: 'first-publish-disabled',
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
        reason: 'first publish while disabled',
      }),
    ).resolves.toMatchObject({ revision: 1 });
    expect((await service.getDetail(provider.id)).draft).toMatchObject({
      enabled: false,
      status: 'published',
    });
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

  it('rejects direct DB credential and sensitive-endpoint pollution before revision/public output', async () => {
    const { service } = createService();
    const credential = 'direct-db-pollution-credential';
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Direct pollution target',
      enabled: true,
      providerKey: 'direct-pollution',
      reason: 'create',
      secret: { operation: 'replace', value: credential },
      source: 'custom',
    });
    const detail = await service.getDetail(provider.id);
    const model = await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'model',
      type: 'chat',
    });
    await db
      .update(platformAiModels)
      .set({ description: `copied:${credential}` })
      .where(eq(platformAiModels.id, model.id));
    await service.testProvider('admin', { id: provider.id, reason: 'test polluted draft' });
    let rawDraft = await new PlatformAiCatalogModel(db).getProvider(provider.id);
    if (!rawDraft) throw new Error('provider draft missing');
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: platformAiCatalogDraftToken(rawDraft),
        expectedRevision: 0,
        id: provider.id,
        reason: 'reject credential reflection',
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        'Provider credentials must not appear in public catalog fields',
      ]),
    });

    await db
      .update(platformAiModels)
      .set({ description: null })
      .where(eq(platformAiModels.id, model.id));
    await db
      .update(platformAiProviders)
      .set({ config: { endpoint: 'https://example.test/v1?X%2DAPI%2DKEY=smuggled' } })
      .where(eq(platformAiProviders.id, provider.id));
    await service.testProvider('admin', { id: provider.id, reason: 'test endpoint pollution' });
    rawDraft = await new PlatformAiCatalogModel(db).getProvider(provider.id);
    if (!rawDraft) throw new Error('provider draft missing');
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: platformAiCatalogDraftToken(rawDraft),
        expectedRevision: 0,
        id: provider.id,
        reason: 'reject endpoint credential',
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining(['Endpoint must be an HTTP(S) URL without credentials']),
    });
    expect(await db.select().from(platformResourceRevisions)).toEqual([]);
    expect((await new AiCatalogReadService(db).getPublished()).providers).toEqual([]);
  });

  it('rejects credential-reflecting historical revision materialization without moving head', async () => {
    const { service } = createService();
    const credential = 'historical-revision-credential';
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Historical target',
      enabled: true,
      providerKey: 'historical-target',
      reason: 'create',
      secret: { operation: 'replace', value: credential },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    const model = await service.createModel('admin', {
      displayName: 'Version One',
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test v1' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: provider.id,
      reason: 'publish v1',
    });
    detail = await service.getDetail(provider.id);
    await service.updateModel('admin', {
      displayName: 'Version Two',
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: model.id,
      providerId: provider.id,
      reason: 'update v2',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test v2' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'publish v2',
    });

    const [revisionOne] = await db
      .select()
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceId, provider.id),
          eq(platformResourceRevisions.revision, 1),
        ),
      );
    const pollutedPayload = structuredClone(revisionOne.payload);
    (pollutedPayload.models as Array<Record<string, unknown>>)[0].description = credential;
    (pollutedPayload.models as Array<Record<string, unknown>>)[0].settings = {
      publicUrl: 'https://history.example.test/model?X-Amz-Signature=unrelated-signature',
    };
    // Migration 0145 makes revisions immutable; tests inject pollution past the trigger.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .update(platformResourceRevisions)
        .set({ payload: pollutedPayload })
        .where(eq(platformResourceRevisions.id, revisionOne.id));
    });

    detail = await service.getDetail(provider.id);
    await expect(
      service.rollbackProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 2,
        id: provider.id,
        reason: 'reject polluted rollback',
        targetRevision: 1,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: 'credential-bearing URL is not allowed' })],
    });

    (pollutedPayload.models as Array<Record<string, unknown>>)[0].settings = {};
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .update(platformResourceRevisions)
        .set({ payload: pollutedPayload })
        .where(eq(platformResourceRevisions.id, revisionOne.id));
    });
    await expect(
      service.rollbackProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 2,
        id: provider.id,
        reason: 'reject credential-reflecting materialization',
        targetRevision: 1,
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect(await db.select().from(platformResourceRevisions)).toHaveLength(2);
    expect((await service.getDetail(provider.id)).published?.models[0].displayName).toBe(
      'Version Two',
    );
  });

  it('blocks publish and rollback when their target removes a newly referenced model', async () => {
    const { service } = createService();
    const publishTarget = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Publish removal target',
      enabled: true,
      providerKey: 'publish-removal',
      reason: 'create',
      secret: { operation: 'replace', value: 'publish-removal-key' },
      source: 'custom',
    });
    let detail = await service.getDetail(publishTarget.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: publishTarget.id,
      reason: 'chat model',
      type: 'chat',
    });
    detail = await service.getDetail(publishTarget.id);
    const removed = await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'removed-chat',
      providerId: publishTarget.id,
      reason: 'removable model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: publishTarget.id, reason: 'test v1' });
    detail = await service.getDetail(publishTarget.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: publishTarget.id,
      reason: 'publish v1',
    });
    detail = await service.getDetail(publishTarget.id);
    await service.deleteModel('admin', {
      expectedDraftToken: detail.draftToken,
      id: removed.id,
      providerId: publishTarget.id,
      reason: 'remove in draft before dependency exists',
    });
    await createPublishedAgentDependency(db, {
      agentKey: 'publish-removal-agent',
      modelKey: 'removed-chat',
      providerKey: 'publish-removal',
    });
    await service.testProvider('admin', { id: publishTarget.id, reason: 'retest removal' });
    detail = await service.getDetail(publishTarget.id);
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 1,
        id: publishTarget.id,
        reason: 'must preserve referenced model',
      }),
    ).rejects.toBeInstanceOf(AiCatalogResourceInUseError);
    expect((await service.getDetail(publishTarget.id)).published?.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ modelKey: 'removed-chat' })]),
    );

    await db.execute(sql`TRUNCATE TABLE ${platformAgentVersions}, ${platformAgents} CASCADE`);
    const rollbackTarget = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Rollback removal target',
      enabled: true,
      providerKey: 'rollback-removal',
      reason: 'create',
      secret: { operation: 'replace', value: 'rollback-removal-key' },
      source: 'custom',
    });
    detail = await service.getDetail(rollbackTarget.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: rollbackTarget.id,
      reason: 'chat model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: rollbackTarget.id, reason: 'test v1' });
    detail = await service.getDetail(rollbackTarget.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: rollbackTarget.id,
      reason: 'publish v1',
    });
    detail = await service.getDetail(rollbackTarget.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'v2-only',
      providerId: rollbackTarget.id,
      reason: 'v2 model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: rollbackTarget.id, reason: 'test v2' });
    detail = await service.getDetail(rollbackTarget.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: rollbackTarget.id,
      reason: 'publish v2',
    });
    await createPublishedAgentDependency(db, {
      agentKey: 'rollback-removal-agent',
      modelKey: 'v2-only',
      providerKey: 'rollback-removal',
    });
    detail = await service.getDetail(rollbackTarget.id);
    await expect(
      service.rollbackProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 2,
        id: rollbackTarget.id,
        reason: 'must preserve rollback dependency',
        targetRevision: 1,
      }),
    ).rejects.toBeInstanceOf(AiCatalogResourceInUseError);
    expect((await service.getDetail(rollbackTarget.id)).published?.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ modelKey: 'v2-only' })]),
    );
  });

  it('checks all removed models for one provider in one batched resolver call', async () => {
    const resolveDependentsForModels = vi.fn(async () => []);
    const { service } = createService(undefined, resolveDependentsForModels);
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Batch removal provider',
      enabled: true,
      providerKey: 'batch-removal',
      reason: 'create',
      secret: { operation: 'replace', value: 'batch-removal-key' },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'chat model',
      type: 'chat',
    });
    detail = await service.getDetail(provider.id);
    const firstRemoved = await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'batch-a',
      providerId: provider.id,
      reason: 'first removable model',
      type: 'chat',
    });
    detail = await service.getDetail(provider.id);
    const secondRemoved = await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'batch-b',
      providerId: provider.id,
      reason: 'second removable model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test v1' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: provider.id,
      reason: 'publish all models',
    });
    expect(resolveDependentsForModels).not.toHaveBeenCalled();

    detail = await service.getDetail(provider.id);
    await service.deleteModel('admin', {
      expectedDraftToken: detail.draftToken,
      id: firstRemoved.id,
      providerId: provider.id,
      reason: 'remove first',
    });
    detail = await service.getDetail(provider.id);
    await service.deleteModel('admin', {
      expectedDraftToken: detail.draftToken,
      id: secondRemoved.id,
      providerId: provider.id,
      reason: 'remove second',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test removal' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'publish removals',
    });

    expect(resolveDependentsForModels).toHaveBeenCalledOnce();
    expect(resolveDependentsForModels).toHaveBeenCalledWith(expect.anything(), 'batch-removal', [
      'batch-a',
      'batch-b',
    ]);
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
        await createPublishedAgentDependency(tx, {
          agentKey: 'concurrent-agent',
          modelKey: 'chat',
          providerKey: 'concurrent-provider',
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
