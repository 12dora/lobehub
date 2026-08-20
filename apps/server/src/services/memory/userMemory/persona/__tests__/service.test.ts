// @vitest-environment node
import { type LobeChatDatabase } from '@lobechat/database';
import { users, userSettings } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { UserPersonaExtractor } from '@lobechat/memory-user-memory';
import { ModelRuntime } from '@lobechat/model-runtime';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checksumPayload,
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { UserPersonaModel } from '@/database/models/userMemory/persona';
import type * as AiInfraReposModule from '@/database/repositories/aiInfra';
import {
  platformAiProviders,
  platformManagedResourcePolicies,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import { PlatformSecretService } from '@/server/enterprise/security/secret';
import { AiCatalogExecutionResolver } from '@/server/enterprise/services/aiCatalog';
import { clearAiCatalogRuntimeCache } from '@/server/enterprise/services/aiCatalog/runtimeAdapter';
import { deletePlatformResourceRevisionsForTest } from '@/server/enterprise/testing/deletePlatformResourceRevisions';
import * as PlatformAiRuntimeBridge from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';
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
  // Side channel that tells the resolver each row's runtime provider; what it carries is
  // asserted in extract's own suite, here it only has to stay transparent.
  withProviderRuntimeProviders: vi.fn((keyVaults: unknown) => keyVaults),
}));

let db: LobeChatDatabase;
const userId = 'user-persona-service';
const PERSONA_PROVIDER_ID = 'persona-provider';
const originalManagedAiFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;

/**
 * Enterprise flags ship ON by default, so this suite pins its own baseline: everything off,
 * and each managed case opts `ENABLE_PLATFORM_MANAGED_AI` back in. Without this the settings
 * policy / managed-resource flags change how platform AI takeover resolves.
 */
const OTHER_ENTERPRISE_FLAGS = [
  'ENABLE_DATABASE_OIDC',
  'ENABLE_ENTERPRISE_ADMIN',
  'ENABLE_PLATFORM_ADMIN',
  'ENABLE_PLATFORM_MANAGED_AGENTS',
  'ENABLE_PLATFORM_MANAGED_CONNECTORS',
  'ENABLE_PLATFORM_MANAGED_SKILLS',
  'ENABLE_PLATFORM_SETTINGS_POLICY',
  'ENABLE_RUNTIME_BRANDING',
] as const;
const originalOtherFlags = Object.fromEntries(
  OTHER_ENTERPRISE_FLAGS.map((key) => [key, process.env[key]]),
);

/** Catalog authority only surfaces revisions joined from a non-zero provider pointer. */
const seedPublishedPersonaProvider = async (modelType: 'chat' | 'image') => {
  const payload = {
    models: [{ enabled: true, modelKey: 'gpt-mock', type: modelType }],
    provider: {
      displayName: 'OpenAI',
      enabled: true,
      providerKey: 'openai',
      source: 'builtin',
    },
  };
  await db.insert(platformAiProviders).values({
    displayName: 'OpenAI',
    enabled: true,
    id: PERSONA_PROVIDER_ID,
    providerKey: 'openai',
    revision: 1,
    status: 'published',
  });
  await db.insert(platformResourceRevisions).values({
    checksum: checksumPayload(payload),
    payload,
    resourceId: PERSONA_PROVIDER_ID,
    resourceType: 'provider',
    revision: 1,
    status: 'published',
  });
};

// PGlite applies the migration baseline once — do not re-open getTestDB per test.
beforeAll(async () => {
  db = await getTestDB();
}, 120_000);

beforeEach(async () => {
  // Managed AI is on by default now, so the unmanaged baseline has to disable it explicitly.
  process.env.ENABLE_PLATFORM_MANAGED_AI = '0';
  for (const key of OTHER_ENTERPRISE_FLAGS) process.env[key] = '0';
  clearAiCatalogRuntimeCache();
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

  // Suite owns a fixed provider revision fixture only (SG-07).
  await deletePlatformResourceRevisionsForTest(db, {
    resourceIds: [PERSONA_PROVIDER_ID],
    resourceType: 'provider',
  });
  await db.delete(platformAiProviders).where(eq(platformAiProviders.id, PERSONA_PROVIDER_ID));
  await db.delete(userSettings).where(eq(userSettings.id, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.insert(users).values({ id: userId });

  // Platform takeover is authorized by the published 平台托管 policy. The managed cases in this
  // suite additionally set ENABLE_PLATFORM_MANAGED_AI; without the flag the predicate short-
  // circuits to false and never reads these rows.
  await db.delete(platformManagedResourcePolicies);
  const policyModel = new PlatformManagedResourcePolicyModel(db);
  await policyModel.ensureRows();
  const policies = createUnmanagedResourcePolicyMap();
  policies.aiModels = { enforcementMode: 'enforced', managed: true };
  policies.aiProviders = { enforcementMode: 'enforced', managed: true };
  await policyModel.materializePublished({ policies, revision: 1 });
});

afterAll(() => {
  if (originalManagedAiFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
  else process.env.ENABLE_PLATFORM_MANAGED_AI = originalManagedAiFlag;
  for (const key of OTHER_ENTERPRISE_FLAGS) {
    const original = originalOtherFlags[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
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
    await seedPublishedPersonaProvider('chat');
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

  it('model-only takeover rejects unpublished models on the user-credential path', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    const listed = vi
      .spyOn(PlatformAiRuntimeBridge, 'listPlatformPublishedModels')
      .mockResolvedValue(null);
    const modelTakeover = vi
      .spyOn(PlatformAiRuntimeBridge, 'isPlatformAiModelTakeoverActive')
      .mockResolvedValue(true);
    const execution = vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    );
    const runtimeState = vi
      .spyOn(PlatformAiRuntimeBridge, 'resolvePlatformAiRuntimeState')
      .mockImplementation(async ({ upstreamState }) => ({
        ...upstreamState,
        enabledAiModels: [
          { abilities: {}, enabled: true, id: 'gpt-mock', providerId: 'openai', type: 'image' },
        ],
      }));

    try {
      await expect(
        new UserPersonaService(db).composeWriting({ userId, username: 'User' }),
      ).rejects.toMatchObject({ code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' });
      expect(listed).toHaveBeenCalled();
      expect(modelTakeover).toHaveBeenCalled();
      expect(execution).not.toHaveBeenCalled();
    } finally {
      listed.mockRestore();
      modelTakeover.mockRestore();
      execution.mockRestore();
      runtimeState.mockRestore();
    }
  });

  it('model-only takeover runs published models on user credentials (providers not hosted)', async () => {
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    const listed = vi
      .spyOn(PlatformAiRuntimeBridge, 'listPlatformPublishedModels')
      .mockResolvedValue(null);
    const modelTakeover = vi
      .spyOn(PlatformAiRuntimeBridge, 'isPlatformAiModelTakeoverActive')
      .mockResolvedValue(true);
    const runtimeState = vi
      .spyOn(PlatformAiRuntimeBridge, 'resolvePlatformAiRuntimeState')
      .mockImplementation(async ({ upstreamState }) => upstreamState);
    const execution = vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    );

    try {
      const result = await new UserPersonaService(db).composeWriting({ userId, username: 'User' });
      expect(result.document.persona).toBe('# Persona');
      expect(execution).not.toHaveBeenCalled();
      expect(vi.mocked(resolveRuntimeAgentConfig)).toHaveBeenCalled();
    } finally {
      listed.mockRestore();
      modelTakeover.mockRestore();
      runtimeState.mockRestore();
      execution.mockRestore();
    }
  });

  it('runs a user-only provider on the user credentials while 平台托管 is published', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    const modelTakeover = vi
      .spyOn(PlatformAiRuntimeBridge, 'isPlatformAiModelTakeoverActive')
      .mockResolvedValue(false);
    const runtimeStateSpy = vi
      .spyOn(PlatformAiRuntimeBridge, 'resolvePlatformAiRuntimeState')
      .mockImplementation(async ({ upstreamState }) => ({
        ...upstreamState,
        runtimeConfig: {
          openai: { config: {}, keyVaults: {}, settings: {} },
          ...upstreamState.runtimeConfig,
        },
      }));
    const listed = vi
      .spyOn(PlatformAiRuntimeBridge, 'listPlatformPublishedModels')
      .mockResolvedValue(null);
    // The platform publishes `openai`; the persona writer resolves to a provider the platform
    // does not publish as enabled, so it stays the user's own (BYOK) — the same boundary the
    // chat runtime and the picker use.
    await seedPublishedPersonaProvider('chat');
    aiInfraMocks.tryMatchingProviderFrom.mockResolvedValue('anthropic');
    aiInfraMocks.getAiProviderRuntimeState.mockResolvedValue({
      enabledAiModels: [
        { abilities: {}, enabled: true, id: 'gpt-mock', providerId: 'anthropic', type: 'chat' },
      ],
      enabledAiProviders: [{ id: 'anthropic', name: 'Anthropic', source: 'builtin' }],
      enabledChatAiProviders: [{ id: 'anthropic', name: 'Anthropic', source: 'builtin' }],
      enabledImageAiProviders: [],
      enabledVideoAiProviders: [],
      runtimeConfig: {
        anthropic: { config: {}, keyVaults: { apiKey: 'user-own-anthropic-key' }, settings: {} },
      },
    });
    const secretFactory = vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise');
    const execution = vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    );

    try {
      const result = await new UserPersonaService(db).composeWriting({ userId, username: 'User' });

      expect(result.document.persona).toBe('# Persona');
      // No platform assertion, no platform credential resolution for an unmanaged provider.
      expect(execution).not.toHaveBeenCalled();
      expect(secretFactory).not.toHaveBeenCalled();
      const [, vaults, options] = vi.mocked(resolveRuntimeAgentConfig).mock.calls[0]!;
      expect(vaults).toMatchObject({ anthropic: { apiKey: 'user-own-anthropic-key' } });
      expect(options).toMatchObject({ preferred: { providerIds: ['anthropic'] } });
      // The managed provider is still merged in, credential-free.
      expect(vaults).toMatchObject({ openai: {} });
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
      else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      modelTakeover.mockRestore();
      runtimeStateSpy.mockRestore();
      listed.mockRestore();
      secretFactory.mockRestore();
      execution.mockRestore();
    }
  });

  it('rejects an unpublished persona model before secret resolution or SDK initialization', async () => {
    const previousFlag = process.env.ENABLE_PLATFORM_MANAGED_AI;
    process.env.ENABLE_PLATFORM_MANAGED_AI = '1';
    // Published image-only catalog — chat persona model is not available.
    await seedPublishedPersonaProvider('image');
    const runtimeState = vi
      .spyOn(PlatformAiRuntimeBridge, 'resolvePlatformAiRuntimeState')
      .mockImplementation(async ({ upstreamState }) => ({
        ...upstreamState,
        enabledAiModels: [
          { abilities: {}, enabled: true, id: 'gpt-mock', providerId: 'openai', type: 'image' },
        ],
      }));
    const listed = vi
      .spyOn(PlatformAiRuntimeBridge, 'listPlatformPublishedModels')
      .mockResolvedValue([
        { abilities: {}, enabled: true, id: 'gpt-mock', providerId: 'openai', type: 'image' },
      ] as never);
    const secretFactory = vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise');
    const execution = vi.spyOn(
      AiCatalogExecutionResolver.prototype,
      'resolveProviderExecutionConfig',
    );
    const initialize = vi.spyOn(ModelRuntime, 'initializeWithProvider');

    try {
      await expect(
        new UserPersonaService(db).composeWriting({ userId, username: 'User' }),
      ).rejects.toMatchObject({ code: 'PLATFORM_AI_MODEL_NOT_PUBLISHED' });
      expect(listed).toHaveBeenCalled();
      expect(secretFactory).not.toHaveBeenCalled();
      expect(execution).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_PLATFORM_MANAGED_AI;
      else process.env.ENABLE_PLATFORM_MANAGED_AI = previousFlag;
      runtimeState.mockRestore();
      listed.mockRestore();
      secretFactory.mockRestore();
      execution.mockRestore();
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

  it('projects persona writer reasoningEffort onto generateObject params', async () => {
    await db.insert(userSettings).values({
      id: userId,
      systemAgent: {
        userMemoryPersonaWriter: {
          model: 'gpt-mock',
          provider: 'openai',
          reasoningEffort: 'high',
        },
      },
    });
    aiInfraMocks.getAiProviderRuntimeState.mockResolvedValue({
      enabledAiModels: [
        {
          abilities: {},
          enabled: true,
          id: 'gpt-mock',
          providerId: 'openai',
          settings: { extendParams: ['gpt5_6ReasoningEffort'] },
          type: 'chat',
        },
      ],
      enabledAiProviders: [],
      enabledChatAiProviders: [],
      enabledImageAiProviders: [],
      runtimeConfig: {},
    });

    const service = new UserPersonaService(db);
    await service.composeWriting({ userId, username: 'User' });

    expect(UserPersonaExtractor).toHaveBeenCalledWith(
      expect.objectContaining({
        generateObjectParams: { reasoning_effort: 'high' },
        model: 'gpt-mock',
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
