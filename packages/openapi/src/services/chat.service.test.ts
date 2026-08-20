import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SYSTEM_AGENT_CONFIG } from '@/const/settings';

import { ChatService } from './chat.service';

vi.mock('@/const/rbac', () => ({
  ALL_SCOPE: 'all',
}));

vi.mock('@/database/models/rbac', () => ({
  RbacModel: class {},
}));

vi.mock('@/database/schemas', () => ({
  agents: {},
  agentsToSessions: {},
  aiModels: {},
  aiProviders: {},
  files: {},
  knowledgeBases: {},
  messages: {},
  sessions: {},
  topics: {},
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    getUserKeyVaults: vi.fn(),
    initWithEnvKey: vi.fn(),
  },
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeWithUserPayload: vi.fn(),
  resolvePlatformBrowserProfile: vi.fn(),
}));

vi.mock('@/database/repositories/aiInfra', () => ({
  AiInfraRepos: class {},
}));

const getEffectiveTaskAgentItem = vi.hoisted(() => vi.fn());

vi.mock('@/server/services/systemAgent', () => ({
  SystemAgentService: class {
    getEffectiveTaskAgentItem = getEffectiveTaskAgentItem;
  },
}));

vi.mock('@/server/services/systemAgent/effort', () => ({
  resolveServiceModelEffortParams: vi.fn(),
}));

describe('ChatService.getSystemTranslationModelConfig', () => {
  beforeEach(() => {
    getEffectiveTaskAgentItem.mockReset();
  });

  it('propagates SystemAgentService failures instead of falling back to unrestricted defaults', async () => {
    getEffectiveTaskAgentItem.mockRejectedValue(new Error('resolver down'));

    const svc = new ChatService({} as never, 'user-1');

    await expect((svc as any).getSystemTranslationModelConfig()).rejects.toThrow('resolver down');
  });

  it('uses the built-in translation default when the effective item is absent', async () => {
    getEffectiveTaskAgentItem.mockResolvedValue(undefined);

    const svc = new ChatService({} as never, 'user-1');

    await expect((svc as any).getSystemTranslationModelConfig()).resolves.toEqual({
      model: DEFAULT_SYSTEM_AGENT_CONFIG.translation.model,
      provider: DEFAULT_SYSTEM_AGENT_CONFIG.translation.provider,
      reasoningEffort: undefined,
    });
  });
});
