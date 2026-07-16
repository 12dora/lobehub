// @vitest-environment node
import { ModelRuntime } from '@lobechat/model-runtime';
import type { AiProviderRuntimeState } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService } from './adminService';
import {
  AiCatalogExecutionResolver,
  AiCatalogRuntimeAdapter,
  clearAiCatalogRuntimeCache,
  compareAiCatalogRuntimeStates,
  createAiCatalogModelAllowlistHooks,
  recordAiCatalogShadowComparison,
} from './runtimeAdapter';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(41), keyId: 'runtime-test' }),
  providerId: 'test',
};
const secretService = new PlatformSecretService({ keyProvider });
const flags = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true };
const upstreamState: AiProviderRuntimeState = {
  enabledAiModels: [
    {
      abilities: { vision: true },
      contextWindowTokens: 64_000,
      enabled: true,
      id: 'chat',
      providerId: 'alpha',
      type: 'chat',
    },
    { enabled: true, id: 'user-only', providerId: 'user-provider', type: 'chat' },
  ],
  enabledAiProviders: [
    { id: 'alpha', name: 'Built-in Alpha', source: 'builtin' },
    { id: 'user-provider', name: 'User', source: 'custom' },
  ],
  enabledChatAiProviders: [],
  enabledImageAiProviders: [],
  enabledVideoAiProviders: [],
  runtimeConfig: {
    'alpha': { config: {}, keyVaults: { apiKey: 'user-key-must-not-win' }, settings: {} },
    'user-provider': { config: {}, keyVaults: { apiKey: 'user-only' }, settings: {} },
  },
};

const cleanup = async () => {
  clearAiCatalogRuntimeCache();
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformAiProviderSecrets);
  await db.delete(platformAiModels);
  await db.delete(platformAiProviders);
};

beforeEach(cleanup);
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const createPublishedProvider = async () => {
  const service = new AiCatalogAdminService(db, secretService, {
    connectionProbe: async () => {},
  });
  const provider = await service.createProviderDraft('admin', {
    checkModel: 'chat',
    config: { endpoint: 'https://private-runtime.example.test/v1' },
    displayName: 'Platform Alpha',
    enabled: true,
    providerKey: 'alpha',
    reason: 'create',
    secret: { operation: 'replace', value: 'published-key-v1' },
    source: 'builtin',
  });
  let detail = await service.getDetail(provider.id);
  await service.createModel('admin', {
    contextWindowTokens: 128_000,
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
  return { provider, service };
};

describe('AiCatalogRuntimeAdapter', () => {
  it('flag-off returns the exact upstream state without reading the catalog', async () => {
    const failOnReadDb = new Proxy(
      {},
      {
        get: () => {
          throw new Error('catalog DB must not be read while the flag is disabled');
        },
      },
    ) as LobeChatDatabase;
    const adapter = new AiCatalogRuntimeAdapter(failOnReadDb);
    const result = await adapter.resolve({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS },
      upstreamState,
    });
    expect(result).toBe(upstreamState);
  });

  it('separates public metadata cache from server execution secrets across publish and rollback', async () => {
    const { provider, service } = await createPublishedProvider();
    const adapter = new AiCatalogRuntimeAdapter(db);
    const execution = new AiCatalogExecutionResolver(db, secretService);
    let executionConfig = await execution.resolveProviderExecutionConfig('alpha');
    expect(executionConfig.keyVaults).toEqual({
      apiKey: 'published-key-v1',
      baseURL: 'https://private-runtime.example.test/v1',
    });
    let state = await adapter.resolve({ flags, upstreamState });
    expect(state.enabledAiProviders.map((item) => item.id)).toEqual(['alpha']);
    expect(state.enabledAiModels).toEqual([
      expect.objectContaining({
        abilities: {},
        contextWindowTokens: 128_000,
        id: 'chat',
        providerId: 'alpha',
      }),
    ]);
    expect(state.runtimeConfig.alpha).toEqual({
      config: {},
      fetchOnClient: false,
      keyVaults: {},
      settings: {},
    });
    expect(state.runtimeConfig).not.toHaveProperty('user-provider');
    const [{ encryptedKeyVaults }] = await db.select().from(platformAiProviders);
    const publicJson = JSON.stringify(state);
    expect(publicJson).not.toContain('published-key-v1');
    expect(publicJson).not.toContain('private-runtime.example.test');
    expect(publicJson).not.toContain(encryptedKeyVaults!);

    let detail = await service.getDetail(provider.id);
    await service.updateProviderDraft('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'clear draft only',
      secret: { operation: 'clear' },
    });
    clearAiCatalogRuntimeCache();
    state = await adapter.resolve({ flags, upstreamState });
    expect(state.runtimeConfig.alpha.keyVaults).toEqual({});
    executionConfig = await execution.resolveProviderExecutionConfig('alpha');
    expect(executionConfig.keyVaults.apiKey).toBe('published-key-v1');

    detail = await service.getDetail(provider.id);
    await service.updateProviderDraft('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'replace draft',
      secret: { operation: 'replace', value: 'published-key-v2' },
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test v2' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'publish v2',
    });
    clearAiCatalogRuntimeCache();
    state = await adapter.resolve({ flags, upstreamState });
    expect(state.runtimeConfig.alpha.keyVaults).toEqual({});
    executionConfig = await execution.resolveProviderExecutionConfig('alpha');
    expect(executionConfig.keyVaults.apiKey).toBe('published-key-v2');

    detail = await service.getDetail(provider.id);
    await service.rollbackProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 2,
      id: provider.id,
      reason: 'rollback v1',
      targetRevision: 1,
    });
    clearAiCatalogRuntimeCache();
    state = await adapter.resolve({ flags, upstreamState });
    expect(state.runtimeConfig.alpha.keyVaults).toEqual({});
    executionConfig = await execution.resolveProviderExecutionConfig('alpha');
    expect(executionConfig.keyVaults.apiKey).toBe('published-key-v1');
    expect(JSON.stringify(state)).not.toContain('published-key');
  });

  it('orders managed providers by catalog sort without falling back to provider id', async () => {
    const { service } = await createPublishedProvider();
    const first = await service.createProviderDraft('admin', {
      checkModel: 'first-chat',
      displayName: 'Sort First',
      enabled: true,
      providerKey: 'zeta-first',
      reason: 'create sorted provider',
      secret: { operation: 'replace', value: 'sort-secret' },
      sort: -10,
      source: 'custom',
    });
    let detail = await service.getDetail(first.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'first-chat',
      providerId: first.id,
      reason: 'model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: first.id, reason: 'test sorted provider' });
    detail = await service.getDetail(first.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: first.id,
      reason: 'publish sorted provider',
    });

    const state = await new AiCatalogRuntimeAdapter(db).resolve({ flags, upstreamState });
    expect(state.enabledAiProviders.map((provider) => provider.id)).toEqual([
      'zeta-first',
      'alpha',
    ]);
  });

  it('rejects disabled, unknown, and wrong-operation models before the provider SDK', async () => {
    const service = new AiCatalogAdminService(db, secretService, {
      connectionProbe: async () => {},
    });
    const provider = await service.createProviderDraft('admin', {
      checkModel: 'allow-1',
      displayName: 'Allowlist Provider',
      enabled: true,
      providerKey: 'allowlist-provider',
      reason: 'create allowlist provider',
      secret: { operation: 'replace', value: 'allowlist-secret' },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    for (const model of [
      { enabled: true, modelKey: 'allow-1', type: 'chat' },
      { enabled: true, modelKey: 'allow-embedding', type: 'embedding' },
      { enabled: true, modelKey: 'allow-tts', type: 'tts' },
      { enabled: true, modelKey: 'allow-asr', type: 'asr' },
      { enabled: false, modelKey: 'deny-1', type: 'chat' },
    ]) {
      await service.createModel('admin', {
        ...model,
        expectedDraftToken: detail.draftToken,
        providerId: provider.id,
        reason: `create ${model.modelKey}`,
      });
      detail = await service.getDetail(provider.id);
    }
    await service.testProvider('admin', { id: provider.id, reason: 'test allowlist provider' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: provider.id,
      reason: 'publish allowlist',
    });
    const execution = await new AiCatalogExecutionResolver(
      db,
      secretService,
    ).resolveProviderExecutionConfig('allowlist-provider');
    expect(execution.allowedModels).toEqual([
      { modelKey: 'allow-1', type: 'chat' },
      { modelKey: 'allow-asr', type: 'asr' },
      { modelKey: 'allow-embedding', type: 'embedding' },
      { modelKey: 'allow-tts', type: 'tts' },
    ]);

    const providerSdk = {
      chat: vi.fn().mockResolvedValue(new Response('ok')),
      embeddings: vi.fn().mockResolvedValue([[1, 2, 3]]),
      textToSpeech: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      transcribe: vi.fn().mockResolvedValue({ text: 'ok' }),
    };
    const runtime = new ModelRuntime(
      providerSdk as never,
      createAiCatalogModelAllowlistHooks(execution.allowedModels),
    );

    await expect(runtime.chat({ messages: [], model: 'deny-1' })).rejects.toMatchObject({
      code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
    });
    await expect(runtime.chat({ messages: [], model: 'unknown' })).rejects.toMatchObject({
      code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
    });
    await expect(runtime.embeddings({ input: 'blocked', model: 'allow-1' })).rejects.toMatchObject({
      code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
    });
    await expect(
      runtime.textToSpeech({ input: 'blocked', model: 'deny-tts', voice: 'voice' }),
    ).rejects.toMatchObject({ code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' });
    await expect(runtime.transcribe({ file: new Blob(), model: 'deny-asr' })).rejects.toMatchObject(
      { code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' },
    );
    expect(providerSdk.chat).not.toHaveBeenCalled();
    expect(providerSdk.embeddings).not.toHaveBeenCalled();
    expect(providerSdk.textToSpeech).not.toHaveBeenCalled();
    expect(providerSdk.transcribe).not.toHaveBeenCalled();

    await expect(runtime.chat({ messages: [], model: 'allow-1' })).resolves.toBeInstanceOf(
      Response,
    );
    await expect(
      runtime.embeddings({ input: 'allowed', model: 'allow-embedding' }),
    ).resolves.toEqual([[1, 2, 3]]);
    await expect(
      runtime.textToSpeech({ input: 'allowed', model: 'allow-tts', voice: 'voice' }),
    ).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(runtime.transcribe({ file: new Blob(), model: 'allow-asr' })).resolves.toEqual({
      text: 'ok',
    });
    expect(providerSdk.chat).toHaveBeenCalledOnce();
    expect(providerSdk.embeddings).toHaveBeenCalledOnce();
  });

  it('maps every managed runtime operation to its catalog model type', async () => {
    const hooks = createAiCatalogModelAllowlistHooks([
      { modelKey: 'chat-model', type: 'chat' },
      { modelKey: 'embedding-model', type: 'embedding' },
      { modelKey: 'image-model', type: 'image' },
      { modelKey: 'tts-model', type: 'tts' },
      { modelKey: 'asr-model', type: 'asr' },
      { modelKey: 'video-model', type: 'video' },
    ]);

    await expect(hooks.beforeChat?.({ model: 'chat-model' } as never)).resolves.toBeUndefined();
    await expect(
      hooks.beforeGenerateObject?.({ model: 'chat-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeEmbeddings?.({ model: 'embedding-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeCreateImage?.({ model: 'image-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeCreateVideo?.({ model: 'video-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeTextToSpeech?.({ model: 'tts-model' } as never),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeTranscribe?.({ model: 'asr-model' } as never),
    ).resolves.toBeUndefined();
    await expect(hooks.beforeCreateImage?.({ model: 'chat-model' } as never)).rejects.toMatchObject(
      { errorType: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' },
    );
  });

  it('produces a bounded secret-free shadow comparison', () => {
    const managed = {
      ...upstreamState,
      enabledAiModels: upstreamState.enabledAiModels.slice(0, 1),
      enabledAiProviders: upstreamState.enabledAiProviders.slice(0, 1),
      runtimeConfig: { alpha: upstreamState.runtimeConfig.alpha },
    };
    const comparison = compareAiCatalogRuntimeStates(upstreamState, managed);
    expect(comparison).toMatchObject({
      managedModelCount: 1,
      managedProviderCount: 1,
      providerOnlyInUpstream: ['user-provider'],
    });
    expect(recordAiCatalogShadowComparison(upstreamState, managed)).toEqual(comparison);
    expect(JSON.stringify(comparison)).not.toContain('user-key-must-not-win');
  });
});
