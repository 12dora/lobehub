import { ModelRuntime } from '@lobechat/model-runtime';
import { generateBrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import { type AiProviderRuntimeState } from '@lobechat/types';
import { type EnabledAiModel } from 'model-bank';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformSecretService } from '@/server/enterprise/security/secret';
import { AiCatalogExecutionResolver } from '@/server/enterprise/services/aiCatalog';
import type * as AiCatalogEnforcement from '@/server/enterprise/services/aiCatalog/enforcement';
import { type MemoryExtractionPrivateConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import * as ModelRuntimeModule from '@/server/modules/ModelRuntime';
import * as PlatformAiRuntimeBridge from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';

import {
  makeTaskErrorItem,
  MemoryExtractionExecutor,
  resolveRuntimeAgentConfig,
  withProviderRuntimeProviders,
} from '../extract';

/** Providers the platform does NOT publish as enabled — i.e. the caller's own (BYOK). */
const userOnlyProviders = vi.hoisted(() => new Set<string>());

const takeoverFromEnv = vi.hoisted(() => () => ({
  models: process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER === '1',
  providers:
    ['1', 'true', 'yes', 'on'].includes(
      (process.env.ENABLE_PLATFORM_MANAGED_AI ?? '').trim().toLowerCase(),
    ) && process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER !== '0',
}));

// Platform takeover is authorized by the published 平台托管 policy, which lives in the DB; the
// executor holds a lazy server DB handle these unit cases do not stand up. Mock just that
// predicate and keep the suite's existing convention that ENABLE_PLATFORM_MANAGED_AI means
// "the platform governs this user" (the gate itself is covered by enforcement.test.ts).
// The execution resolver seam is gated on the same predicate; these cases stand up neither a
// DB nor a policy table, so let the env-flag convention above stand in for it.
vi.mock('@/server/enterprise/services/aiCatalog/enforcement', async (importOriginal) => ({
  ...(await importOriginal<typeof AiCatalogEnforcement>()),
  isPlatformAiTakeoverActive: vi.fn(async () => true),
}));
vi.mock('@/server/modules/ModelRuntime/platformAiRuntimeBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformAiRuntimeBridge>()),
  getPlatformAiTakeoverFlags: vi.fn(async () => takeoverFromEnv()),
  isPlatformAiModelTakeoverActive: vi.fn(async () => takeoverFromEnv().models),
  isPlatformAiTakeoverActive: vi.fn(async () => takeoverFromEnv().providers),
  // `null` = "not actively managed" → the provider is the user's own (BYOK). Default: every
  // provider is platform-owned while the flag is on, matching this suite's convention.
  listPlatformCatalogModels: vi.fn(async (_db: unknown, providerKey: string) =>
    process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER === '1' && !userOnlyProviders.has(providerKey)
      ? [{ enabled: true, id: `${providerKey}-published`, providerId: providerKey, type: 'chat' }]
      : null,
  ),
  listPlatformPublishedModels: vi.fn(async (_db: unknown, providerKey: string) =>
    ['1', 'true', 'yes', 'on'].includes(
      (process.env.ENABLE_PLATFORM_MANAGED_AI ?? '').trim().toLowerCase(),
    ) &&
    process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER !== '0' &&
    !userOnlyProviders.has(providerKey)
      ? []
      : null,
  ),
}));

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

describe('resolveRuntimeAgentConfig installation identity', () => {
  const grokProfile = generateBrowserDeviceProfile({ seed: 'memory-grok-profile' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The unmanaged path used to construct the provider SDK directly, which for Grok means
   * no installation id at all — the request would either present the bundled fallback
   * device or fail on the wire.
   */
  it('routes a Grok selection through the server seam with the installation profile', async () => {
    const spy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);
    const resolveBrowserProfile = vi.fn().mockResolvedValue(grokProfile);

    await resolveRuntimeAgentConfig(
      { model: 'grok-4.6', provider: 'grok' },
      { grok: { apiKey: 'grok-user-key' } },
      { resolveBrowserProfile, userId: 'memory-user' },
    );

    expect(resolveBrowserProfile).toHaveBeenCalledWith('grok');
    expect(spy.mock.calls[0][1] as Record<string, unknown>).toMatchObject({
      apiKey: 'grok-user-key',
      installationId: grokProfile.installationId,
    });
    // Memory extraction is a one-off operation, never the user's chat conversation.
    expect((spy.mock.calls[0][1] as Record<string, unknown>).conversationKey).toMatch(
      /^user:memory-user:op:/,
    );
  });

  it('refuses such a selection with an actionable error when no profile can be resolved', async () => {
    await expect(
      resolveRuntimeAgentConfig(
        { model: 'grok-4.6', provider: 'grok' },
        { grok: { apiKey: 'grok-user-key' } },
        { userId: 'memory-user' },
      ),
    ).rejects.toThrow(/installation browser profile/);
  });

  /**
   * A user's own provider row can be backed by the Grok SDK under any catalog id. The
   * predicate must run on the RUNTIME provider, otherwise this selection skips the seam and
   * is built without an installation identity at all.
   */
  it('routes a custom provider whose sdkType is grok through the seam as well', async () => {
    const spy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);
    const resolveBrowserProfile = vi.fn().mockResolvedValue(grokProfile);

    await resolveRuntimeAgentConfig(
      { model: 'grok-4.6', provider: 'my-grok' },
      withProviderRuntimeProviders(
        { 'my-grok': { apiKey: 'custom-grok-key' } },
        { 'my-grok': { settings: { sdkType: 'grok' } } },
      ),
      { resolveBrowserProfile, userId: 'memory-user' },
    );

    expect(resolveBrowserProfile).toHaveBeenCalledWith('grok');
    // The Grok SDK is constructed, not an OpenAI-compatible client under the custom id.
    expect(spy.mock.calls[0][0]).toBe('grok');
    expect(spy.mock.calls[0][1] as Record<string, unknown>).toMatchObject({
      apiKey: 'custom-grok-key',
      installationId: grokProfile.installationId,
    });
  });

  it('leaves a custom provider with an ordinary sdkType on the direct construction', async () => {
    const spy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);
    const resolveBrowserProfile = vi.fn();

    await resolveRuntimeAgentConfig(
      { model: 'gpt-4o-mini', provider: 'my-gateway' },
      withProviderRuntimeProviders(
        { 'my-gateway': { apiKey: 'gateway-key' } },
        { 'my-gateway': { settings: { sdkType: 'openai' } } },
      ),
      { resolveBrowserProfile, userId: 'memory-user' },
    );

    expect(resolveBrowserProfile).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('my-gateway', {
      apiKey: 'gateway-key',
      userId: 'memory-user',
    });
  });

  it('leaves an ordinary provider on the untouched direct construction', async () => {
    const spy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);
    const resolveBrowserProfile = vi.fn();

    await resolveRuntimeAgentConfig(
      { model: 'gpt-4o-mini', provider: 'openai' },
      { openai: { apiKey: 'openai-user-key', baseURL: 'https://proxy.example' } },
      { resolveBrowserProfile, userId: 'memory-user' },
    );

    expect(resolveBrowserProfile).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('openai', {
      apiKey: 'openai-user-key',
      baseURL: 'https://proxy.example',
      userId: 'memory-user',
    });
  });

  it('scopes unmanaged ChatGPT Web account keys by workspaceId', async () => {
    const spy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);
    const chatgptProfile = generateBrowserDeviceProfile({ seed: 'memory-chatgptweb-workspace' });
    const resolveBrowserProfile = vi.fn().mockResolvedValue(chatgptProfile);

    await resolveRuntimeAgentConfig(
      { model: 'gpt-5', provider: 'chatgptweb' },
      { chatgptweb: { apiKey: 'chatgpt-user-token' } },
      { resolveBrowserProfile, userId: 'memory-user', workspaceId: 'ws-1' },
    );
    await resolveRuntimeAgentConfig(
      { model: 'gpt-5', provider: 'chatgptweb' },
      { chatgptweb: { apiKey: 'chatgpt-user-token' } },
      { resolveBrowserProfile, userId: 'memory-user', workspaceId: 'ws-2' },
    );

    const accountIds = spy.mock.calls.map(
      (call) => (call[1] as Record<string, unknown>).browserSessionAccountId,
    );
    expect(accountIds).toEqual([
      'user:memory-user:ws-1:chatgptweb',
      'user:memory-user:ws-2:chatgptweb',
    ]);
    expect(accountIds[0]).not.toBe('user:memory-user:_:chatgptweb');
  });
});

describe('MemoryExtractionExecutor.resolveRuntimeKeyVaults', () => {
  it('blocks unpublished managed memory models before the provider SDK', async () => {
    const initSpy = vi.spyOn(ModelRuntimeModule, 'initModelRuntimeWithUserPayload');
    const runtime = await resolveRuntimeAgentConfig(
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
    expect(initSpy).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ apiKey: 'platform-memory-secret' }),
      expect.objectContaining({ managedBy: 'platform', userId: 'memory-user' }),
      expect.anything(),
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

  it('leaves a user-only provider on its own credentials while the platform owns the others', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    // The platform governs only what it publishes as enabled; `provider-e` is the user's own.
    userOnlyProviders.add('provider-e');
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
    // No embedding model is published, so the embedding role falls back to the configured
    // `provider-e`. Under the old all-or-nothing branch that combination threw
    // PLATFORM_AI_MODEL_NOT_PUBLISHED; a user-only provider must simply use the user's vault.
    const runtimeState = createRuntimeState(
      [
        { abilities: {}, enabled: true, id: 'gate-2', providerId: 'provider-b', type: 'chat' },
        ...['layer-act', 'layer-ctx', 'layer-exp', 'layer-id', 'layer-pref'].map((id) => ({
          abilities: {},
          enabled: true,
          id,
          providerId: 'provider-l',
          type: 'chat' as const,
        })),
      ],
      {
        'provider-b': { apiKey: 'user-vault-must-not-win' },
        'provider-e': { apiKey: 'user-own-embedding-key' },
      },
    );

    try {
      const keyVaults = await resolveRuntimeKeyVaults(executor, runtimeState);

      expect(keyVaults).toEqual({
        'provider-b': { apiKey: 'platform-secret-provider-b' },
        'provider-e': { apiKey: 'user-own-embedding-key' },
        'provider-l': { apiKey: 'platform-secret-provider-l' },
      });
      // Platform credentials are resolved only for the providers the platform owns.
      expect(execution.mock.calls.map(([providerKey]) => providerKey).sort()).toEqual([
        'provider-b',
        'provider-l',
      ]);
      expect(secretFactory).toHaveBeenCalledTimes(2);
    } finally {
      userOnlyProviders.delete('provider-e');
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

  it('model-only takeover rejects an unpublished model on the user-credential path', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    const previousProvider = process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER;
    const previousModel = process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER = '0';
    process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER = '1';
    const secretFactory = vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise');
    const execution = vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    );
    const executor = createExecutor();
    const runtimeState = createRuntimeState(
      [{ abilities: {}, enabled: true, id: 'gate-2', providerId: 'provider-b', type: 'image' }],
      { 'provider-b': { apiKey: 'user-key' } },
    );

    try {
      await expect(resolveRuntimeKeyVaults(executor, runtimeState)).rejects.toMatchObject({
        code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
      });
      expect(secretFactory).not.toHaveBeenCalled();
      expect(execution).not.toHaveBeenCalled();
    } finally {
      process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      if (previousProvider === undefined) delete process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER;
      else process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER = previousProvider;
      if (previousModel === undefined) delete process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER;
      else process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER = previousModel;
      vi.restoreAllMocks();
    }
  });

  it('model-only takeover keeps user credentials for published models (providers not hosted)', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    const previousProvider = process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER;
    const previousModel = process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER = '0';
    process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER = '1';
    const execution = vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    );
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
      expect(execution).not.toHaveBeenCalled();
    } finally {
      process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      if (previousProvider === undefined) delete process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER;
      else process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER = previousProvider;
      if (previousModel === undefined) delete process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER;
      else process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER = previousModel;
      vi.restoreAllMocks();
    }
  });

  it('both hosted uses platform credentials and still rejects unpublished models', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    const previousModel = process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER = '1';
    const execution = vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    );
    const secretFactory = vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise');
    const executor = createExecutor();
    const runtimeState = createRuntimeState(
      [{ abilities: {}, enabled: true, id: 'gate-2', providerId: 'provider-b', type: 'image' }],
      { 'provider-b': { apiKey: 'user-key' } },
    );

    try {
      await expect(resolveRuntimeKeyVaults(executor, runtimeState)).rejects.toMatchObject({
        code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED',
      });
      expect(execution).not.toHaveBeenCalled();
      expect(secretFactory).not.toHaveBeenCalled();
    } finally {
      process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      if (previousModel === undefined) delete process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER;
      else process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER = previousModel;
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
    expect(memoryServiceConfig.agents.gatekeeper.reasoningEffort).toBeUndefined();
    expect(memoryServiceConfig.agents.layerExtractor.reasoningEffort).toBeUndefined();
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

  it('copies reasoningEffort onto gatekeeper and layer extractor from memory analysis config', () => {
    const executor = createExecutor({
      agentGateKeeper: {
        model: 'gate-1',
        provider: 'provider-gate',
      },
      agentLayerExtractor: {
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
        model: 'analysis-1',
        provider: 'provider-analysis',
        reasoningEffort: 'high',
      },
    });

    expect(memoryServiceConfig.agents.gatekeeper.reasoningEffort).toBe('high');
    expect(memoryServiceConfig.agents.layerExtractor.reasoningEffort).toBe('high');
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

  it('threads workspaceId so two workspaces do not share a ChatGPT Web account key', async () => {
    const chatgptProfile = generateBrowserDeviceProfile({ seed: 'memory-chatgptweb-getRuntime' });
    vi.spyOn(ModelRuntimeModule, 'resolvePlatformBrowserProfile').mockResolvedValue(chatgptProfile);
    const spy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);

    const executor = createExecutor({
      embedding: { model: 'embed-1', provider: 'chatgptweb' },
      agentGateKeeper: { model: 'gate-2', provider: 'chatgptweb' },
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
        provider: 'chatgptweb',
      },
    });
    const memoryServiceConfig = (executor as any).resolveUserMemoryServiceConfig();
    const keyVaults = { chatgptweb: { apiKey: 'chatgpt-user-token' } };

    try {
      await (executor as any).getRuntime('memory-user', memoryServiceConfig, keyVaults, 'ws-1');
      await (executor as any).getRuntime('memory-user', memoryServiceConfig, keyVaults, 'ws-2');

      const accountIds = [
        ...new Set(
          spy.mock.calls.map(
            (call) => (call[1] as Record<string, unknown>).browserSessionAccountId,
          ),
        ),
      ];
      expect(accountIds).toEqual([
        'user:memory-user:ws-1:chatgptweb',
        'user:memory-user:ws-2:chatgptweb',
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('MemoryExtractionExecutor.getRuntime model-takeover cache', () => {
  const userVaults = {
    'provider-b': { apiKey: 'b-key' },
    'provider-e': { apiKey: 'e-key' },
    'provider-l': { apiKey: 'l-key' },
  };

  afterEach(() => {
    delete process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER;
    delete process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER;
    delete process.env.ENABLE_PLATFORM_MANAGED_AI;
    vi.restoreAllMocks();
  });

  it('does not reuse a cached pre-hosting runtime after model takeover activates', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '0';
    process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER = '0';
    const initSpy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);

    const executor = createExecutor();
    const config = (executor as any).resolveUserMemoryServiceConfig();

    await (executor as any).getRuntime('memory-user', config, userVaults);
    const firstInits = initSpy.mock.calls.length;
    expect(firstInits).toBeGreaterThan(0);

    await (executor as any).getRuntime('memory-user', config, userVaults);
    expect(initSpy.mock.calls.length).toBe(firstInits);

    process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER = '1';
    await (executor as any).getRuntime('memory-user', config, userVaults);

    expect(initSpy.mock.calls.length).toBeGreaterThan(firstInits);
    expect(PlatformAiRuntimeBridge.listPlatformCatalogModels).toHaveBeenCalled();
  });

  it('rebuilds the runtime when the published catalog is replaced', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER = '0';
    process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER = '1';

    const initSpy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);

    vi.mocked(PlatformAiRuntimeBridge.listPlatformCatalogModels).mockImplementation(
      async (_db, providerKey) => [
        {
          abilities: {},
          enabled: true,
          id: `${providerKey}-rev-1`,
          providerId: providerKey,
          type: 'chat',
        },
      ],
    );

    const executor = createExecutor();
    const config = (executor as any).resolveUserMemoryServiceConfig();

    await (executor as any).getRuntime('memory-user', config, userVaults);
    const firstInits = initSpy.mock.calls.length;
    expect(firstInits).toBeGreaterThan(0);
    expect(PlatformAiRuntimeBridge.listPlatformCatalogModels).toHaveBeenCalled();
    const firstCatalogCalls = vi.mocked(PlatformAiRuntimeBridge.listPlatformCatalogModels).mock
      .calls.length;

    vi.mocked(PlatformAiRuntimeBridge.listPlatformCatalogModels).mockImplementation(
      async (_db, providerKey) => [
        {
          abilities: {},
          enabled: true,
          id: `${providerKey}-rev-2`,
          providerId: providerKey,
          type: 'chat',
        },
      ],
    );

    await (executor as any).getRuntime('memory-user', config, userVaults);
    expect(initSpy.mock.calls.length).toBeGreaterThan(firstInits);
    expect(
      vi.mocked(PlatformAiRuntimeBridge.listPlatformCatalogModels).mock.calls.length,
    ).toBeGreaterThan(firstCatalogCalls);
  });

  it('does not keep a hosted allowlist after model takeover deactivates', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER = '0';
    process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER = '1';

    const initSpy = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as unknown as ModelRuntime);

    const executor = createExecutor();
    const config = (executor as any).resolveUserMemoryServiceConfig();

    await (executor as any).getRuntime('memory-user', config, userVaults);
    const hostedInits = initSpy.mock.calls.length;
    expect(hostedInits).toBeGreaterThan(0);
    expect(PlatformAiRuntimeBridge.listPlatformCatalogModels).toHaveBeenCalled();

    vi.mocked(PlatformAiRuntimeBridge.listPlatformCatalogModels).mockClear();
    delete process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER;

    await (executor as any).getRuntime('memory-user', config, userVaults);
    expect(initSpy.mock.calls.length).toBeGreaterThan(hostedInits);
    expect(PlatformAiRuntimeBridge.listPlatformCatalogModels).not.toHaveBeenCalled();

    const unhostedInits = initSpy.mock.calls.length;
    await (executor as any).getRuntime('memory-user', config, userVaults);
    expect(initSpy.mock.calls.length).toBe(unhostedInits);
  });
});

describe('MemoryExtractionExecutor.loadExtractionRuntimes snapshot', () => {
  afterEach(() => {
    delete process.env.TEST_PLATFORM_AI_MODEL_TAKEOVER;
    delete process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER;
    delete process.env.ENABLE_PLATFORM_MANAGED_AI;
    vi.restoreAllMocks();
  });

  it('reads the policy snapshot once through the production extraction sequence', async () => {
    // Flag on + models unpublished: each predicate would re-read the policy table.
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    process.env.TEST_PLATFORM_AI_PROVIDER_TAKEOVER = '0';

    vi.spyOn(ModelRuntime, 'initializeWithProvider').mockReturnValue({} as unknown as ModelRuntime);

    const flagsSpy = vi.mocked(PlatformAiRuntimeBridge.getPlatformAiTakeoverFlags);
    flagsSpy.mockImplementation(async () => takeoverFromEnv());
    flagsSpy.mockClear();
    vi.mocked(PlatformAiRuntimeBridge.isPlatformAiModelTakeoverActive).mockClear();
    vi.mocked(PlatformAiRuntimeBridge.isPlatformAiTakeoverActive).mockClear();

    const executor = createExecutor();
    const runtimeState = createRuntimeState(
      [
        {
          abilities: {},
          enabled: true,
          id: 'embed-1',
          providerId: 'provider-e',
          type: 'embedding',
        },
        { abilities: {}, enabled: true, id: 'gate-2', providerId: 'provider-b', type: 'chat' },
        ...['layer-act', 'layer-ctx', 'layer-exp', 'layer-id', 'layer-pref'].map((id) => ({
          abilities: {},
          enabled: true,
          id,
          providerId: 'provider-l',
          type: 'chat' as const,
        })),
      ],
      {
        'provider-b': { apiKey: 'b-key' },
        'provider-e': { apiKey: 'e-key' },
        'provider-l': { apiKey: 'l-key' },
      },
    );

    await (executor as any).loadExtractionRuntimes({
      memoryServiceConfig: (executor as any).resolveUserMemoryServiceConfig(),
      runtimeState,
      userId: 'memory-user',
    });

    expect(flagsSpy).toHaveBeenCalledOnce();
    expect(PlatformAiRuntimeBridge.isPlatformAiModelTakeoverActive).not.toHaveBeenCalled();
    expect(PlatformAiRuntimeBridge.isPlatformAiTakeoverActive).not.toHaveBeenCalled();
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
