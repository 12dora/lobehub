// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  platformAiModels,
  platformAiProviders,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import { AiCatalogReadService } from './catalogReadService';

const serverDB: LobeChatDatabase = await getTestDB();
const service = new AiCatalogReadService(serverDB);

const cleanup = async () => {
  const ownedProviders = await serverDB
    .select({ id: platformAiProviders.id })
    .from(platformAiProviders);
  await deletePlatformResourceRevisionsForTest(serverDB, {
    resourceIds: ownedProviders.map((row) => row.id),
    resourceType: 'provider',
  });
  await serverDB.delete(platformAiModels);
  await serverDB.delete(platformAiProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('AiCatalogReadService', () => {
  it('returns only enabled public fields from latest published snapshots', async () => {
    const [provider] = await serverDB
      .insert(platformAiProviders)
      .values({
        displayName: 'Alpha',
        providerKey: 'alpha',
        revision: 1,
        status: 'published',
      })
      .returning();
    const payload = {
      models: [
        {
          abilities: { vision: true },
          config: {
            deploymentName: 'safe-deployment',
            endpoint: 'https://private-model.example.test',
            organization: 'private-runtime-field',
          },
          contextWindowTokens: 128_000,
          enabled: true,
          id: 'model-row',
          modelKey: 'chat',
          parameters: { maxTokens: 4096 },
          providerId: provider.id,
          revision: 0,
          settings: {},
          sort: 1,
          status: 'draft',
          type: 'chat',
        },
        { enabled: false, modelKey: 'disabled', type: 'chat' },
      ],
      provider: {
        config: { endpoint: 'https://private.example.test', headers: { authorization: 'secret' } },
        displayName: 'Alpha',
        enabled: true,
        id: provider.id,
        providerKey: 'alpha',
        secretConfigured: true,
        secretFingerprint: 'fp',
        sort: 1,
        source: 'custom',
      },
    };
    await serverDB.insert(platformResourceRevisions).values({
      checksum: checksumPayload(payload),
      payload,
      resourceId: provider.id,
      resourceType: 'provider',
      revision: 1,
      status: 'published',
    });

    const result = await service.getPublished();
    expect(result.providers).toEqual([
      expect.objectContaining({
        models: [
          expect.objectContaining({
            config: { deploymentName: 'safe-deployment' },
            contextWindowTokens: 128_000,
            modelKey: 'chat',
          }),
        ],
        providerKey: 'alpha',
        revision: 1,
      }),
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private.example.test');
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('private-model.example.test');
    expect(serialized).not.toContain('private-runtime-field');
    expect(serialized).not.toContain('secretFingerprint');
    expect(serialized).not.toContain('disabled');
  });

  it('omits ChatGPT Web legacy-alias rows from the published dependency picker', async () => {
    const [provider] = await serverDB
      .insert(platformAiProviders)
      .values({
        displayName: 'ChatGPT Web',
        providerKey: 'chatgptweb',
        revision: 1,
        status: 'published',
      })
      .returning();
    const payload = {
      models: [
        {
          enabled: true,
          modelKey: 'gpt-5-6',
          settings: {},
          sort: 0,
          type: 'chat',
        },
        {
          enabled: true,
          modelKey: 'gpt-5-6-thinking',
          settings: { legacyAlias: 'gpt-5-6' },
          sort: 1,
          type: 'chat',
        },
      ],
      provider: {
        displayName: 'ChatGPT Web',
        enabled: true,
        id: provider.id,
        providerKey: 'chatgptweb',
        sort: 0,
        source: 'builtin',
      },
    };
    await serverDB.insert(platformResourceRevisions).values({
      checksum: checksumPayload(payload),
      payload,
      resourceId: provider.id,
      resourceType: 'provider',
      revision: 1,
      status: 'published',
    });

    const result = await service.getPublished();
    const models = result.providers[0]?.models ?? [];
    expect(models.map((model) => model.modelKey)).toEqual(['gpt-5-6']);
  });

  it('rewrites published gpt5_6ReasoningEffort and omits un-aliased auto/pro leftovers', async () => {
    const [provider] = await serverDB
      .insert(platformAiProviders)
      .values({
        displayName: 'ChatGPT Web',
        providerKey: 'chatgptweb',
        revision: 1,
        status: 'published',
      })
      .returning();
    const payload = {
      models: [
        {
          enabled: true,
          modelKey: 'gpt-5-6',
          settings: { extendParams: ['gpt5_6ReasoningEffort'], searchImpl: 'params' },
          sort: 0,
          type: 'chat',
        },
        {
          enabled: true,
          modelKey: 'auto',
          settings: { extendParams: ['gpt5_6ReasoningEffort'] },
          sort: 1,
          type: 'chat',
        },
        {
          enabled: true,
          modelKey: 'gpt-5-6-pro',
          settings: {},
          sort: 2,
          type: 'chat',
        },
      ],
      provider: {
        displayName: 'ChatGPT Web',
        enabled: true,
        id: provider.id,
        providerKey: 'chatgptweb',
        sort: 0,
        source: 'builtin',
      },
    };
    await serverDB.insert(platformResourceRevisions).values({
      checksum: checksumPayload(payload),
      payload,
      resourceId: provider.id,
      resourceType: 'provider',
      revision: 1,
      status: 'published',
    });

    const result = await service.getPublished();
    const models = result.providers[0]?.models ?? [];
    expect(models.map((model) => model.modelKey)).toEqual(['gpt-5-6']);
    expect(models[0]?.settings).toEqual({
      extendParams: ['chatgptWebReasoningEffort'],
      searchImpl: 'params',
    });
  });
});
