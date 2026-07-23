// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import {
  platformAgents,
  platformAgentVersions,
  platformAiModels,
  platformAiProviders,
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService, AiCatalogResourceInUseError } from './adminService';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(29), keyId: 'model-test' }),
  providerId: 'test',
};
const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }));
const AGENT_DEPENDENCY_CHECKSUM = 'b'.repeat(64);
const agentConfig = {
  avatar: null,
  backgroundColor: null,
  description: 'Exact AI dependent',
  displayName: 'Exact AI dependent',
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Use the exact model dependency.',
  tags: [],
};

const createPublishedAgentDependency = async (params: {
  agentKey: string;
  modelKey: string;
  providerKey: string;
}) => {
  const repository = new PlatformAgentCatalogRepository(db);
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
  await db
    .update(platformAgents)
    .set({ model: 'legacy-poison-model', provider: 'legacy-poison-provider' })
    .where(eq(platformAgents.id, agent.id));
  return agent;
};

const cleanup = async () => {
  // Migration 0145: audit logs are append-only; TRUNCATE bypasses the row trigger.
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformAgentVersions},
      ${platformAgents},
      ${platformSettingPolicies},
      ${platformAiModels},
      ${platformAiProviders}
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(cleanup);
afterEach(cleanup);

const createProviderAndModels = async () => {
  const provider = await service.createProviderDraft('admin', {
    displayName: 'Alpha',
    providerKey: 'alpha',
    reason: 'create',
    source: 'custom',
  });
  let detail = await service.getDetail(provider.id);
  const first = await service.createModel('admin', {
    enabled: true,
    expectedDraftToken: detail.draftToken,
    modelKey: 'first',
    providerId: provider.id,
    reason: 'first model',
    sort: 1,
  });
  detail = await service.getDetail(provider.id);
  const second = await service.createModel('admin', {
    enabled: true,
    expectedDraftToken: detail.draftToken,
    modelKey: 'second',
    providerId: provider.id,
    reason: 'second model',
    sort: 2,
  });
  return { first, provider, second };
};

describe('AiCatalogAdminService model mutations', () => {
  it('rejects copying kept provider credential leaves into model fields', async () => {
    const credential = 'arbitrary-model-credential-leaf';
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Credential boundary',
      providerKey: 'credential-boundary',
      reason: 'create',
      secret: { operation: 'replace', value: { apiKey: credential } },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    await expect(
      service.createModel('admin', {
        description: `copied ${credential}`,
        expectedDraftToken: detail.draftToken,
        modelKey: 'rejected',
        providerId: provider.id,
        reason: 'create rejected model',
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect(await db.select().from(platformAiModels)).toEqual([]);

    const model = await service.createModel('admin', {
      expectedDraftToken: detail.draftToken,
      modelKey: 'safe-model',
      providerId: provider.id,
      reason: 'create safe model',
    });
    detail = await service.getDetail(provider.id);
    await expect(
      service.updateModel('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: model.id,
        providerId: provider.id,
        reason: 'update rejected model',
        settings: { publicNote: credential },
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect((await service.getDetail(provider.id)).draft.models[0].settings).toEqual({});

    detail = await service.getDetail(provider.id);
    await expect(
      service.createModel('admin', {
        config: { documentationUrl: 'https://example.test/model?sig=unrelated-signature' },
        expectedDraftToken: detail.draftToken,
        modelKey: 'signed-url-model',
        providerId: provider.id,
        reason: 'reject signed model URL',
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
  });

  it('reorder fails closed unless items exactly equal the complete locked provider collection', async () => {
    const { first, provider, second } = await createProviderAndModels();
    const detail = await service.getDetail(provider.id);

    await expect(
      service.reorderModels('admin', {
        expectedDraftToken: detail.draftToken,
        items: [{ id: first.id, sort: 9 }],
        providerId: provider.id,
        reason: 'incomplete reorder',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(
      (await db.select().from(platformAiModels).orderBy(platformAiModels.modelKey)).map(
        (row) => row.sort,
      ),
    ).toEqual([1, 2]);

    const complete = await service.reorderModels('admin', {
      expectedDraftToken: detail.draftToken,
      items: [
        { id: first.id, sort: 2 },
        { id: second.id, sort: 1 },
      ],
      providerId: provider.id,
      reason: 'complete reorder',
    });
    expect(complete.updated).toBe(2);
    expect(complete.draftToken).toHaveLength(64);
    expect(
      (await db.select().from(platformAiModels).orderBy(platformAiModels.modelKey)).map(
        (row) => row.sort,
      ),
    ).toEqual([2, 1]);
  });

  it('blocks disabling/deleting models referenced by published agents or settings', async () => {
    const { first, provider, second } = await createProviderAndModels();
    const dependentAgent = await createPublishedAgentDependency({
      agentKey: 'default-agent',
      modelKey: first.modelKey,
      providerKey: provider.providerKey,
    });
    await new PlatformAgentCatalogRepository(db).appendVersionCas({
      agentId: dependentAgent.id,
      config: agentConfig,
      dependencySnapshot: {
        connectors: [],
        model: {
          modelKey: second.modelKey,
          providerChecksum: AGENT_DEPENDENCY_CHECKSUM,
          providerKey: provider.providerKey,
          providerRevision: 2,
        },
        skills: [],
      },
      expectedDraftSequence: 2,
      expectedRevision: 1,
      version: '2.0.0',
    });
    expect(await service.getDependents(provider.id, second.id)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: dependentAgent.id, resourceType: 'agent' }),
      ]),
    );
    await db.insert(platformSettingPolicies).values([
      {
        mode: 'locked',
        path: 'defaultAgent.config.model',
        status: 'published',
        value: { model: first.modelKey, provider: provider.providerKey },
        visibility: 'visible',
      },
      {
        mode: 'locked',
        path: 'systemAgent.topic.model',
        status: 'published',
        value: first.modelKey,
        visibility: 'visible',
      },
      {
        mode: 'locked',
        path: 'systemAgent.topic.provider',
        status: 'published',
        value: provider.providerKey,
        visibility: 'visible',
      },
    ]);

    const dependents = await service.getDependents(provider.id, first.id);
    expect(dependents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'agent' }),
        expect.objectContaining({ resourceType: 'setting' }),
        expect.objectContaining({ label: 'systemAgent.topic', resourceType: 'setting' }),
      ]),
    );
    const detail = await service.getDetail(provider.id);
    await expect(
      service.updateModel('admin', {
        enabled: false,
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: first.id,
        providerId: provider.id,
        reason: 'disable in-use',
      }),
    ).rejects.toBeInstanceOf(AiCatalogResourceInUseError);
    await expect(
      service.deleteModel('admin', {
        expectedDraftToken: detail.draftToken,
        id: first.id,
        providerId: provider.id,
        reason: 'delete in-use',
      }),
    ).rejects.toBeInstanceOf(AiCatalogResourceInUseError);
    expect(
      (await db.select().from(platformAiModels).where(eq(platformAiModels.id, first.id)))[0]
        .enabled,
    ).toBe(true);
  });
});
