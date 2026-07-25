import { ModelRuntime } from '@lobechat/model-runtime';
import { type AiProviderRuntimeState } from '@lobechat/types';
import { type EnabledAiModel } from 'model-bank';
import { describe, expect, it, vi } from 'vitest';

import { PlatformSecretService } from '@/server/enterprise/security/secret';
import { AiCatalogExecutionResolver } from '@/server/enterprise/services/aiCatalog';
import { type MemoryExtractionPrivateConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import * as ModelRuntimeModule from '@/server/modules/ModelRuntime';

import { makeTaskErrorItem, MemoryExtractionExecutor, resolveRuntimeAgentConfig } from '../extract';

const createRuntimeState = (models: EnabledAiModel[], keyVaults: Record<string, any>) =>
  ({
    enabledAiModels: models,
    enabledAiProviders: [],
    enabledChatAiProviders: [],
    enabledImageAiProviders: [],
    enabledVideoAiProviders: [],
    runtimeConfig: Object.fromEntries(
      Object.entries(keyVaults).map(([providerId, vault]) => [
        providerId,
        { config: {}, keyVaults: vault, settings: {} },
      ]),
    ),
  }) as AiProviderRuntimeState;

const createExecutor = (privateOverrides?: Partial<MemoryExtractionPrivateConfig>) => {
  const basePrivateConfig: MemoryExtractionPrivateConfig = {
    agentBenchmarkLoCoMo: { model: 'benchmark-1', provider: 'provider-b' },
    agentGateKeeper: { model: 'gate-2', provider: 'provider-b' },
    agentLayerExtractor: {
      contextLimit: 2048,
      layers: {
        activity: 'layer-act',
        context: 'layer-ctx',
        experience: 'layer-exp',
        identity: 'layer-id',
        preference: 'layer-pref',
      },
      model: 'layer-1',
      provider: 'provider-l',
    },
    agentPersonaWriter: { model: 'persona-1', provider: 'provider-s' },
    concurrency: 1,
    embedding: { model: 'embed-1', provider: 'provider-e' },
    featureFlags: { enableBenchmarkLoCoMo: false },
    observabilityS3: { enabled: false },
    webhook: {},
  };

  const serverConfig = {
    aiProvider: {},
    memory: {},
  };

  // @ts-ignore accessing private constructor for testing
  return new MemoryExtractionExecutor(serverConfig as any, {
    ...basePrivateConfig,
    ...privateOverrides,
  });
};

const resolveRuntimeKeyVaults = async (
  executor: MemoryExtractionExecutor,
  runtimeState: AiProviderRuntimeState,
) => {
  const memoryServiceConfig = (executor as any).resolveUserMemoryServiceConfig();

  return (executor as any).resolveRuntimeKeyVaults(runtimeState, memoryServiceConfig);
};

describe('MemoryExtractionExecutor.resolveRuntimeKeyVaults', () => {
  it('blocks unpublished managed memory models before the provider SDK', async () => {
    const runtime = resolveRuntimeAgentConfig(
      { model: 'allow-memory', provider: 'openai' },
      { openai: { apiKey: 'platform-memory-secret' } },
      {
        managedExecution: {
          allowedModels: [{ modelKey: 'allow-memory', type: 'chat' }],
          config: {},
          keyVaults: { apiKey: 'platform-memory-secret' },
          providerKey: 'openai',
          revision: 1,
          runtimeProvider: 'openai',
        },
        userId: 'memory-user',
      },
    );
    const providerChat = vi.fn().mockResolvedValue(new Response('ok'));
    runtime['_runtime'] = { chat: providerChat } as never;

    await expect(
      runtime.chat({ messages: [], model: 'disabled-or-unknown' }),
    ).rejects.toMatchObject({ errorType: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' });
    expect(providerChat).not.toHaveBeenCalled();
    await expect(runtime.chat({ messages: [], model: 'allow-memory' })).resolves.toBeInstanceOf(
      Response,
    );
    expect(providerChat).toHaveBeenCalledOnce();
  });

  it('uses one-shot platform execution secrets without mutating the public state', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    const secretFactory = vi
      .spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise')
      .mockReturnValue({} as PlatformSecretService);
    const execution = vi
      .spyOn(AiCatalogExecutionResolver.prototype, 'resolveProviderExecutionConfig')
      .mockImplementation(async (providerKey) => ({
        allowedModels: [],
        config: {},
        keyVaults: { apiKey: `platform-secret-${providerKey}` },
        providerKey,
        revision: 1,
        runtimeProvider: providerKey,
      }));
    const executor = createExecutor();
    const runtimeState = createRuntimeState(
      [
        { abilities: {}, enabled: true, id: 'gate-2', providerId: 'provider-b', type: 'chat' },
        {
          abilities: {},
          enabled: true,
          id: 'embed-1',
          providerId: 'provider-e',
          type: 'embedding',
        },
        ...['layer-act', 'layer-ctx', 'layer-exp', 'layer-id', 'layer-pref'].map((id) => ({
          abilities: {},
          enabled: true,
          id,
          providerId: 'provider-l',
          type: 'chat' as const,
        })),
      ],
      {
        'provider-b': { apiKey: 'public-state-must-not-win' },
        'provider-e': {},
        'provider-l': {},
      },
    );

    try {
      const keyVaults = await resolveRuntimeKeyVaults(executor, runtimeState);
      expect(keyVaults).toEqual({
        'provider-b': { apiKey: 'platform-secret-provider-b' },
        'provider-e': { apiKey: 'platform-secret-provider-e' },
        'provider-l': { apiKey: 'platform-secret-provider-l' },
      });
      expect(execution).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(runtimeState)).not.toContain('platform-secret');
      expect(secretFactory).toHaveBeenCalledTimes(3);
    } finally {
      process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      vi.restoreAllMocks();
    }
  });

  it('rejects an unpublished managed model before secret resolution or SDK initialization', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    const secretFactory = vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise');
    const execution = vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    );
    const initialize = vi.spyOn(ModelRuntime, 'initializeWithProvider');
    const executor = createExecutor();
    const runtimeState = createRuntimeState(
      [
        { abilities: {}, enabled: true, id: 'gate-2', providerId: 'provider-b', type: 'image' },
        {
          abilities: {},
          enabled: true,
          id: 'embed-1',
          providerId: 'provider-e',
          type: 'embedding',
        },
        { abilities: {}, enabled: true, id: 'layer-1', providerId: 'provider-l', type: 'chat' },
      ],
      {},
    );

    try {
      await expect(resolveRuntimeKeyVaults(executor, runtimeState)).rejects.toMatchObject({
        code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
      });
      expect(secretFactory).not.toHaveBeenCalled();
      expect(execution).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      vi.restoreAllMocks();
    }
  });

  it('keeps the upstream vault path exact while managed AI is disabled', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    delete process.env.ENABLE_PLATFORM_MANAGED_AI;
    const secretFactory = vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise');
    const executor = createExecutor();
    const runtimeState = createRuntimeState(
      [
        { abilities: {}, enabled: true, id: 'gate-2', providerId: 'provider-b', type: 'chat' },
        {
          abilities: {},
          enabled: true,
          id: 'embed-1',
          providerId: 'provider-e',
          type: 'embedding',
        },
        { abilities: {}, enabled: true, id: 'layer-1', providerId: 'provider-l', type: 'chat' },
      ],
      {
        'provider-b': { apiKey: 'user-gate-key' },
        'provider-e': { apiKey: 'user-embedding-key' },
        'provider-l': { apiKey: 'user-layer-key' },
      },
    );

    try {
      expect(await resolveRuntimeKeyVaults(executor, runtimeState)).toEqual({
        'provider-b': { apiKey: 'user-gate-key' },
        'provider-e': { apiKey: 'user-embedding-key' },
        'provider-l': { apiKey: 'user-layer-key' },
      });
      expect(secretFactory).not.toHaveBeenCalled();
    } finally {
      process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      vi.restoreAllMocks();
    }
  });

  it('drops fallback credentials when user memory provider is overridden', () => {
    const executor = createExecutor({
      embedding: {
        apiKey: 'openai-system-key',
        baseURL: 'https://openai.example.com',
        model: 'embed-1',
        provider: 'openai',
      },
    });

    const memoryServiceConfig = (executor as any).resolveUserMemoryServiceConfig({
      userMemoryEmbedding: {
        model: 'embed-2',
        provider: 'anthropic',
      },
    });

    expect(memoryServiceConfig.agents.embedding).toMatchObject({
      model: 'embed-2',
      provider: 'anthropic',
    });
    expect(memoryServiceConfig.agents.embedding.apiKey).toBeUndefined();
    expect(memoryServiceConfig.agents.embedding.baseURL).toBeUndefined();
  });

  it('keeps fallback credentials when user memory provider is unchanged', () => {
    const executor = createExecutor({
      embedding: {
        apiKey: 'openai-system-key',
        baseURL: 'https://openai.example.com',
        model: 'embed-1',
        provider: 'openai',
      },
    });

    const memoryServiceConfig = (executor as any).resolveUserMemoryServiceConfig({
      userMemoryEmbedding: {
        model: 'embed-2',
        provider: 'openai',
      },
    });

    expect(memoryServiceConfig.agents.embedding).toMatchObject({
      apiKey: 'openai-system-key',
      baseURL: 'https://openai.example.com',
      model: 'embed-2',
      provider: 'openai',
    });
  });

  it('shares ServiceModel memory analysis config between gatekeeper and layer extractor', () => {
    const executor = createExecutor({
      agentGateKeeper: {
        apiKey: 'gate-system-key',
        baseURL: 'https://gate.example.com',
        model: 'gate-1',
        provider: 'provider-gate',
      },
      agentLayerExtractor: {
        apiKey: 'layer-system-key',
        baseURL: 'https://layer.example.com',
        contextLimit: 2048,
        layers: {
          activity: 'layer-act',
          context: 'layer-ctx',
          experience: 'layer-exp',
          identity: 'layer-id',
          preference: 'layer-pref',
        },
        model: 'layer-1',
        provider: 'provider-layer',
      },
    });

    const memoryServiceConfig = (executor as any).resolveUserMemoryServiceConfig({
      memoryAnalysisAgentConfig: {
        contextLimit: 4096,
        model: 'analysis-1',
        provider: 'provider-analysis',
      },
    });

    expect(memoryServiceConfig.agents.gatekeeper).toMatchObject({
      model: 'analysis-1',
      provider: 'provider-analysis',
    });
    expect(memoryServiceConfig.agents.layerExtractor).toMatchObject({
      contextLimit: 4096,
      model: 'analysis-1',
      provider: 'provider-analysis',
    });
    expect(memoryServiceConfig.agents.gatekeeper.apiKey).toBeUndefined();
    expect(memoryServiceConfig.agents.layerExtractor.apiKey).toBeUndefined();
    expect(memoryServiceConfig.modelConfig.gateModel).toBe('analysis-1');
    expect(memoryServiceConfig.modelConfig.layerModels).toEqual({
      activity: 'analysis-1',
      context: 'analysis-1',
      experience: 'analysis-1',
      identity: 'analysis-1',
      preference: 'analysis-1',
    });
  });

  it('uses ServiceModel provider before env preferred providers when provider is overridden', async () => {
    const executor = createExecutor({
      agentGateKeeper: {
        model: 'gate-1',
        provider: 'provider-g',
      },
      agentLayerExtractor: {
        contextLimit: 2048,
        layers: {
          activity: 'layer-1',
          context: 'layer-1',
          experience: 'layer-1',
          identity: 'layer-1',
          preference: 'layer-1',
        },
        model: 'layer-1',
        provider: 'provider-l',
      },
      embedding: {
        apiKey: 'openai-system-key',
        baseURL: 'https://openai.example.com',
        model: 'embed-1',
        provider: 'openai',
      },
      embeddingPreferredProviders: ['provider-b'],
    });

    const memoryServiceConfig = (executor as any).resolveUserMemoryServiceConfig({
      userMemoryEmbedding: {
        model: 'embed-2',
        provider: 'provider-a',
      },
    });
    const runtimeState = createRuntimeState(
      [
        {
          abilities: {},
          enabled: true,
          id: 'gate-1',
          providerId: 'provider-g',
          type: 'chat',
        },
        {
          abilities: {},
          enabled: true,
          id: 'layer-1',
          providerId: 'provider-l',
          type: 'chat',
        },
        {
          abilities: {},
          enabled: true,
          id: 'embed-2',
          providerId: 'provider-a',
          type: 'embedding',
        },
        {
          abilities: {},
          enabled: true,
          id: 'embed-2',
          providerId: 'provider-b',
          type: 'embedding',
        },
      ],
      {
        'provider-a': { apiKey: 'a-key' },
        'provider-b': { apiKey: 'b-key' },
        'provider-g': { apiKey: 'g-key' },
        'provider-l': { apiKey: 'l-key' },
      },
    );

    const keyVaults = await (executor as any).resolveRuntimeKeyVaults(
      runtimeState,
      memoryServiceConfig,
    );

    expect(keyVaults).toMatchObject({
      'provider-a': { apiKey: 'a-key' },
    });
    expect(keyVaults).not.toHaveProperty('provider-b');
  });

  it('prefers configured providers/models for gatekeeper, embedding, and layer extractors', async () => {
    const executor = createExecutor({
      embeddingPreferredProviders: ['provider-c', 'provider-a'],
      agentGateKeeperPreferredModels: ['model-chat-1', 'vendor-prefix/model-chat-1'],
      agentGateKeeperPreferredProviders: ['provider-c', 'provider-a'],
      agentLayerExtractorPreferredProviders: ['provider-c', 'provider-a'],
    });

    const runtimeState = createRuntimeState(
      [
        {
          abilities: {},
          enabled: true,
          id: 'model-chat-1',
          type: 'chat',
          providerId: 'provider-a',
        },
        {
          abilities: {},
          enabled: true,
          id: 'model-embedding-1',
          type: 'embedding',
          providerId: 'provider-e',
        },
        {
          abilities: {},
          enabled: true,
          id: 'vendor-prefix/model-chat-1',
          type: 'chat',
          providerId: 'provider-b',
        },
        {
          abilities: {},
          enabled: true,
          id: 'vendor-prefix/model-embedding-1',
          type: 'embedding',
          providerId: 'provider-b',
        },
        {
          abilities: {},
          enabled: false,
          id: 'model-chat-1',
          type: 'chat',
          providerId: 'provider-c',
        },
        {
          abilities: {},
          enabled: false,
          id: 'model-embedding-1',
          type: 'embedding',
          providerId: 'provider-c',
        },
      ],
      {
        'provider-a': { apiKey: 'a-key' },
        'provider-b': { apiKey: 'b-key' },
        'provider-c': { apiKey: 'c-key' },
        'provider-e': { apiKey: 'e-key' },
      },
    );

    const keyVaults = await resolveRuntimeKeyVaults(executor, runtimeState);

    expect(keyVaults).toMatchObject({
      'provider-a': { apiKey: 'a-key' },
      'provider-e': { apiKey: 'e-key' },
    });
  });

  it('warns and falls back to server provider when no enabled provider satisfies embedding model', async () => {
    const executor = createExecutor();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const runtimeState = createRuntimeState(
      [
        {
          abilities: {},
          enabled: true,
          id: 'model-chat-1',
          type: 'chat',
          providerId: 'provider-a',
        },
        {
          abilities: {},
          enabled: true,
          id: 'model-embedding-1',
          type: 'embedding',
          providerId: 'provider-e',
        },
        {
          abilities: {},
          enabled: true,
          id: 'vendor-prefix/model-chat-1',
          type: 'chat',
          providerId: 'provider-b',
        },
        {
          abilities: {},
          enabled: true,
          id: 'vendor-prefix/model-embedding-1',
          type: 'embedding',
          providerId: 'provider-b',
        },
        {
          abilities: {},
          enabled: false,
          id: 'model-chat-1',
          type: 'chat',
          providerId: 'provider-c',
        },
        {
          abilities: {},
          enabled: false,
          id: 'model-embedding-1',
          type: 'embedding',
          providerId: 'provider-c',
        },
      ],
      {
        'provider-b': { apiKey: 'b-key' },
        'provider-l': { apiKey: 'l-key' },
      },
    );

    const keyVaults = await resolveRuntimeKeyVaults(executor, runtimeState);

    expect(keyVaults).toMatchObject({
      'provider-b': { apiKey: 'b-key' },
      'provider-l': { apiKey: 'l-key' },
    });
    expect(keyVaults).not.toHaveProperty('provider-e');
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('ignores disabled providers when resolving key vaults', async () => {
    const executor = createExecutor({
      embeddingPreferredProviders: ['provider-disabled', 'provider-a'],
    });

    const runtimeState = createRuntimeState(
      [
        {
          abilities: {},
          enabled: false,
          id: 'embed-1',
          type: 'embedding',
          providerId: 'provider-disabled',
        },
        {
          abilities: {},
          enabled: true,
          id: 'embed-1',
          type: 'embedding',
          providerId: 'provider-a',
        },
      ],
      {
        'provider-disabled': { apiKey: 'disabled-key' },
        'provider-a': { apiKey: 'a-key' },
      },
    );

    const keyVaults = await resolveRuntimeKeyVaults(executor, runtimeState);

    expect(keyVaults).toMatchObject({
      'provider-a': { apiKey: 'a-key' },
    });
    expect(keyVaults).not.toHaveProperty('provider-disabled');
  });

  it('respects preferred provider order when multiple providers have the model', async () => {
    const executor = createExecutor({
      agentGateKeeper: {
        model: 'gate-2',
        provider: 'provider-a', // fallback provider differs from preferred order
        apiKey: 'sys-a-key',
        baseURL: 'https://api-a.example.com',
        language: 'English',
      },
      agentGateKeeperPreferredProviders: ['provider-b', 'provider-a'],
    });

    const runtimeState = createRuntimeState(
      [
        { abilities: {}, enabled: true, id: 'gate-2', type: 'chat', providerId: 'provider-a' },
        { abilities: {}, enabled: true, id: 'gate-2', type: 'chat', providerId: 'provider-b' },
      ],
      {
        'provider-a': { apiKey: 'a-key' },
        'provider-b': { apiKey: 'b-key' },
      },
    );

    const keyVaults = await resolveRuntimeKeyVaults(executor, runtimeState);

    expect(keyVaults).toMatchObject({
      'provider-b': { apiKey: 'b-key' }, // picks first preferred provider
    });
    expect(keyVaults).not.toHaveProperty('provider-a');
  });

  it('falls back to configured provider when no enabled models match', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const executor = createExecutor({
      agentGateKeeper: { model: 'gate-2', provider: 'provider-fallback', apiKey: 'sys-fb-key' },
    });

    const runtimeState = createRuntimeState([], {
      'provider-fallback': { apiKey: 'fb-key' },
    });

    const keyVaults = await resolveRuntimeKeyVaults(executor, runtimeState);

    expect(keyVaults).toMatchObject({
      'provider-fallback': { apiKey: 'fb-key' },
    });

    warnSpy.mockRestore();
  });

  it('binds each managed runtime to the provider that published its model (not a shared first-match map)', async () => {
    // Regression for SPC-004: embedding preferences list provider-b first, but only provider-e
    // publishes the embedding model. Gatekeeper correctly selects provider-b. The embedding
    // runtime must still use provider-e — never the shared provider-b execution from gatekeeper.
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise').mockReturnValue(
      {} as PlatformSecretService,
    );
    vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    ).mockImplementation(async (providerKey) => ({
      allowedModels:
        providerKey === 'provider-e'
          ? [{ modelKey: 'embed-1', type: 'embedding' }]
          : providerKey === 'provider-b'
            ? [{ modelKey: 'gate-2', type: 'chat' }]
            : [{ modelKey: 'layer-act', type: 'chat' }],
      config: {},
      keyVaults: { apiKey: `platform-secret-${providerKey}` },
      providerKey,
      revision: 1,
      runtimeProvider: providerKey,
    }));
    const initWithPayload = vi
      .spyOn(ModelRuntimeModule, 'initModelRuntimeWithUserPayload')
      .mockReturnValue({} as ModelRuntime);

    const executor = createExecutor({
      // Embedding prefers provider-b first; only provider-e has the embedding model.
      embeddingPreferredProviders: ['provider-b', 'provider-e'],
    });
    const runtimeState = createRuntimeState(
      [
        { abilities: {}, enabled: true, id: 'gate-2', providerId: 'provider-b', type: 'chat' },
        {
          abilities: {},
          enabled: true,
          id: 'embed-1',
          providerId: 'provider-e',
          type: 'embedding',
        },
        // gate model is NOT published on provider-e; embedding model is NOT on provider-b
        ...['layer-act', 'layer-ctx', 'layer-exp', 'layer-id', 'layer-pref'].map((id) => ({
          abilities: {},
          enabled: true,
          id,
          providerId: 'provider-l',
          type: 'chat' as const,
        })),
      ],
      {
        'provider-b': {},
        'provider-e': {},
        'provider-l': {},
      },
    );

    try {
      const memoryServiceConfig = (executor as any).resolveUserMemoryServiceConfig();
      const keyVaults = await (executor as any).resolveRuntimeKeyVaults(
        runtimeState,
        memoryServiceConfig,
      );
      expect(keyVaults).toMatchObject({
        'provider-b': { apiKey: 'platform-secret-provider-b' },
        'provider-e': { apiKey: 'platform-secret-provider-e' },
        'provider-l': { apiKey: 'platform-secret-provider-l' },
      });

      await (executor as any).getRuntime('memory-user', memoryServiceConfig, keyVaults);

      // resolveRuntimeAgentConfig order: embeddings, gatekeeper, layerExtractor
      const providerKeys = initWithPayload.mock.calls.map((call) => call[0]);
      expect(providerKeys).toEqual(['provider-e', 'provider-b', 'provider-l']);
      // provider-b exactly once (gatekeeper only) — the shared-map bug would init embeddings with it too.
      expect(initWithPayload.mock.calls.filter((call) => call[0] === 'provider-b')).toHaveLength(1);
      expect(initWithPayload.mock.calls.filter((call) => call[0] === 'provider-e')).toHaveLength(1);
    } finally {
      process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      vi.restoreAllMocks();
    }
  });
});

describe('makeTaskErrorItem', () => {
  it('preserves database driver details from nested causes', () => {
    const driverError = new Error('must be able to parse query');
    driverError.name = 'PostgresError';
    Object.assign(driverError, { code: 'XX000' });

    const queryError = new Error('Failed query: select ...', { cause: driverError });
    queryError.name = 'DrizzleQueryError';

    const item = makeTaskErrorItem('retrieval', queryError, {
      sourceId: 'topic-1',
      sourceType: 'chat_topic',
    });

    expect(item).toMatchObject({
      cause: {
        code: 'XX000',
        message: 'must be able to parse query',
        name: 'PostgresError',
      },
      message: 'Failed query: select ...',
      name: 'DrizzleQueryError',
      sourceId: 'topic-1',
      sourceType: 'chat_topic',
      stage: 'retrieval',
    });
  });
});
