// @vitest-environment node
import { type LobeChatDatabase } from '@lobechat/database';
import { users, userSettings } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { ModelRuntime } from '@lobechat/model-runtime';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserPersonaModel } from '@/database/models/userMemory/persona';
import type * as AiInfraReposModule from '@/database/repositories/aiInfra';
import { PlatformSecretService } from '@/server/enterprise/security/secret';
import { AiCatalogExecutionResolver } from '@/server/enterprise/services/aiCatalog';
import { resolveRuntimeAgentConfig } from '@/server/services/memory/userMemory/extract';

import { UserPersonaService } from '../service';

// Use vi.hoisted to ensure mocks are available when vi.mock factory runs
const aiInfraMocks = vi.hoisted(() => ({
  getAiProviderRuntimeState: vi.fn(),
  tryMatchingModelFrom: vi.fn(),
  tryMatchingProviderFrom: vi.fn(),
}));

vi.mock('@/database/repositories/aiInfra', () => {
  const AiInfraRepos = vi.fn().mockImplementation(() => ({
    getAiProviderRuntimeState: aiInfraMocks.getAiProviderRuntimeState,
  })) as unknown as typeof AiInfraReposModule.AiInfraRepos;

  (AiInfraRepos as any).tryMatchingModelFrom = aiInfraMocks.tryMatchingModelFrom;
  (AiInfraRepos as any).tryMatchingProviderFrom = aiInfraMocks.tryMatchingProviderFrom;

  return { AiInfraRepos };
});

vi.mock('@/server/globalConfig/parseMemoryExtractionConfig', () => ({
  parseMemoryExtractionConfig: () => ({
    agentLayerExtractor: {
      apiKey: 'test-key',
      baseURL: 'https://example.com',
      language: 'English',
      layers: { context: 'gpt-mock' },
      model: 'gpt-mock',
      provider: 'openai',
    },
    agentPersonaWriter: {
      apiKey: 'test-key',
      baseURL: 'https://example.com',
      language: 'English',
      model: 'gpt-mock',
      provider: 'openai',
    },
  }),
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { getUserKeyVaults: vi.fn() },
}));

const structuredResult = {
  diff: '- updated',
  memoryIds: ['mem-1'],
  persona: '# Persona',
  reasoning: 'reason',
  sourceIds: ['src-1'],
  summary: 'summary',
};

const toolCall = vi.fn().mockResolvedValue(structuredResult);

vi.mock('@lobechat/memory-user-memory', () => ({
  UserPersonaExtractor: vi.fn().mockImplementation(() => ({
    toolCall,
  })),
}));

vi.mock('@/server/services/memory/userMemory/extract', () => ({
  resolveRuntimeAgentConfig: vi.fn().mockResolvedValue({}),
}));

let db: LobeChatDatabase;
const userId = 'user-persona-service';
const originalManagedAiFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;

beforeEach(async () => {
  delete process.env.ENABLE_PLATFORM_MANAGED_AI;
  toolCall.mockClear();
  aiInfraMocks.getAiProviderRuntimeState.mockReset();
  vi.mocked(resolveRuntimeAgentConfig).mockClear();
  aiInfraMocks.tryMatchingModelFrom.mockReset();
  aiInfraMocks.tryMatchingProviderFrom.mockReset();
  aiInfraMocks.tryMatchingModelFrom.mockResolvedValue('openai');
  aiInfraMocks.tryMatchingProviderFrom.mockResolvedValue('openai');
  aiInfraMocks.getAiProviderRuntimeState.mockResolvedValue({
    enabledAiModels: [
      { abilities: {}, enabled: true, id: 'gpt-mock', providerId: 'openai', type: 'chat' },
    ],
    enabledAiProviders: [],
    enabledChatAiProviders: [],
    enabledImageAiProviders: [],
    runtimeConfig: {
      openai: { keyVaults: { apiKey: 'vault-key', baseURL: 'https://vault.example.com' } },
    },
  });
  db = await getTestDB();

  await db.delete(users);
  await db.insert(users).values({ id: userId });
});

afterAll(() => {
  if (originalManagedAiFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
  else process.env.ENABLE_PLATFORM_MANAGED_AI = originalManagedAiFlag;
});

describe('UserPersonaService', () => {
  it('composes and persists persona via agent', async () => {
    const service = new UserPersonaService(db);
    const result = await service.composeWriting({
      personaNotes: '- note',
      recentEvents: '- event',
      retrievedMemories: '- mem',
      userId,
      username: 'User',
    });

    expect(toolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'English',
        username: 'User',
      }),
    );
    expect(result.document.persona).toBe('# Persona');

    const model = new UserPersonaModel(db, userId);
    const latest = await model.getLatestPersonaDocument();
    expect(latest?.version).toBe(1);
  });

  it('passes a one-shot platform secret to the runtime without exposing it', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    const fakeSecret = 'platform-persona-secret-not-for-output';
    const secretFactory = vi
      .spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise')
      .mockReturnValue({} as PlatformSecretService);
    const execution = vi
      .spyOn(AiCatalogExecutionResolver.prototype, 'resolveProviderExecutionConfig')
      .mockResolvedValue({
        allowedModels: [{ modelKey: 'gpt-mock', type: 'chat' }],
        config: {},
        keyVaults: { apiKey: fakeSecret },
        providerKey: 'openai',
        revision: 1,
        runtimeProvider: 'openai',
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const initialize = vi
      .spyOn(ModelRuntime, 'initializeWithProvider')
      .mockReturnValue({} as ModelRuntime);

    try {
      const service = new UserPersonaService(db);
      const result = await service.composeWriting({ userId, username: 'User' });

      expect(execution).toHaveBeenCalledWith('openai');
      expect(resolveRuntimeAgentConfig).not.toHaveBeenCalled();
      expect(initialize).toHaveBeenCalledWith(
        'openai',
        expect.objectContaining({ apiKey: fakeSecret }),
        expect.objectContaining({ beforeChat: expect.any(Function) }),
      );
      const managedHooks = initialize.mock.calls[0][2];
      await expect(
        managedHooks?.beforeChat?.({ messages: [], model: 'not-published' }),
      ).rejects.toMatchObject({ errorType: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' });
      expect(JSON.stringify(result)).not.toContain(fakeSecret);
      expect(JSON.stringify(aiInfraMocks.getAiProviderRuntimeState.mock.results)).not.toContain(
        fakeSecret,
      );
      expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain(fakeSecret);
    } finally {
      secretFactory.mockRestore();
      execution.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      initialize.mockRestore();
    }
  });

  it('passes existing persona baseline on subsequent runs', async () => {
    const service = new UserPersonaService(db);
    await service.composeWriting({ userId, username: 'User' });
    await service.composeWriting({ userId, username: 'User' });

    expect(toolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        existingPersona: '# Persona',
      }),
    );
  });

  it('drops fallback credentials when persona writer provider is overridden', async () => {
    await db.insert(userSettings).values({
      id: userId,
      systemAgent: {
        userMemoryPersonaWriter: {
          model: 'claude-mock',
          provider: 'anthropic',
        },
      },
    });
    aiInfraMocks.tryMatchingProviderFrom.mockResolvedValue('anthropic');
    aiInfraMocks.getAiProviderRuntimeState.mockResolvedValue({
      enabledAiModels: [
        { abilities: {}, enabled: true, id: 'claude-mock', providerId: 'anthropic', type: 'chat' },
      ],
      enabledAiProviders: [],
      enabledChatAiProviders: [],
      enabledImageAiProviders: [],
      runtimeConfig: {},
    });

    const service = new UserPersonaService(db);
    await service.composeWriting({ userId, username: 'User' });

    expect(resolveRuntimeAgentConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        apiKey: undefined,
        baseURL: undefined,
        model: 'claude-mock',
        provider: 'anthropic',
      }),
      expect.any(Object),
      expect.objectContaining({
        fallback: {
          apiKey: undefined,
          baseURL: undefined,
        },
      }),
      undefined,
    );
  });
});
