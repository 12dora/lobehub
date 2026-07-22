import type * as ModelBankModule from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiAgentService } from '../index';

const {
  mockComposioCtor,
  mockCreateOperation,
  mockCreateServerAgentToolsEngine,
  mockGetAgentConfig,
  mockGetComposioManifests,
  mockGetLobehubSkillManifests,
  mockMarketCtor,
  mockMessageCreate,
  mockPluginQuery,
  mockResolveConnectorGovernance,
} = vi.hoisted(() => ({
  mockComposioCtor: vi.fn(),
  mockCreateOperation: vi.fn(),
  mockCreateServerAgentToolsEngine: vi.fn().mockReturnValue({
    generateToolsDetailed: vi.fn().mockReturnValue({ enabledToolIds: [], tools: [] }),
    getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
  }),
  mockGetAgentConfig: vi.fn(),
  mockGetComposioManifests: vi.fn(),
  mockGetLobehubSkillManifests: vi.fn(),
  mockMarketCtor: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockPluginQuery: vi.fn().mockResolvedValue([]),
  mockResolveConnectorGovernance: vi.fn(),
}));

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    initWithEnvKey: vi.fn().mockResolvedValue({ decrypt: vi.fn(), encrypt: vi.fn() }),
  },
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(() => ({
    create: mockMessageCreate,
    getLatestNonToolMessageId: vi.fn().mockResolvedValue(undefined),
    getLatestSpineMessageId: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn().mockImplementation(() => ({
    getAgentConfig: vi.fn(),
    queryAgents: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(() => ({ getAgentConfig: mockGetAgentConfig })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({ query: mockPluginQuery })),
}));

vi.mock('@/database/models/connector', () => ({
  ConnectorModel: vi.fn().mockImplementation(() => ({
    queryByIdentifiers: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/connectorTool', () => ({
  ConnectorToolModel: vi.fn().mockImplementation(() => ({
    queryAllByConnectorIds: vi.fn().mockResolvedValue([]),
    queryByConnector: vi.fn().mockResolvedValue([]),
    queryByConnectorIds: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ id: 'topic-1' }),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/database/models/thread', () => ({
  ThreadModel: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
  })),
}));

vi.mock('@/server/services/agentRuntime', () => ({
  AgentRuntimeService: vi.fn().mockImplementation(() => ({ createOperation: mockCreateOperation })),
}));

// Capture WHICH identity each Skill/Composio service instance is constructed
// with, and record it on every manifest fetch, so the governance shared-owner
// substitution is observable.
vi.mock('@/server/services/market', () => ({
  MarketService: mockMarketCtor.mockImplementation((options: any) => ({
    getLobehubSkillManifests: () => mockGetLobehubSkillManifests(options?.userInfo?.userId),
  })),
}));

vi.mock('@/server/services/composio', () => ({
  ComposioService: mockComposioCtor.mockImplementation((options: any) => ({
    getComposioManifests: () => mockGetComposioManifests(options?.userId),
  })),
}));

// The governance resolver is stubbed until storage lands — tests always mock it.
vi.mock('@/server/enterprise/services/connectorGovernance/resolve', () => ({
  resolveConnectorGovernance: mockResolveConnectorGovernance,
}));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({ uploadFromUrl: vi.fn() })),
}));

vi.mock('@/server/modules/Mecha', () => ({
  createServerAgentToolsEngine: mockCreateServerAgentToolsEngine,
  serverMessagesEngine: vi.fn().mockResolvedValue([{ content: 'test', role: 'user' }]),
}));

vi.mock('@/server/services/deviceGateway', () => ({
  deviceGateway: { isConfigured: false, queryDeviceList: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));

vi.mock('model-bank', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelBankModule>();
  return {
    ...actual,
    LOBE_DEFAULT_MODEL_LIST: [
      { abilities: { functionCall: true }, id: 'gpt-4', providerId: 'openai' },
    ],
  };
});

const inactiveGovernance = {
  active: false,
  builtinToolPolicies: {},
  sharedAuthOwnerUserId: null,
};

const engineParams = () => mockCreateServerAgentToolsEngine.mock.calls[0][1] as any;
const operationManifestMap = () =>
  mockCreateOperation.mock.calls[0][0].toolSet.manifestMap as Record<string, any>;

describe('AiAgentService.execAgent - connector governance', () => {
  let service: AiAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ id: 'msg-1' });
    mockCreateOperation.mockResolvedValue({
      autoStarted: true,
      messageId: 'queue-msg-1',
      operationId: 'op-123',
      success: true,
    });
    mockGetAgentConfig.mockResolvedValue({
      chatConfig: {},
      id: 'agent-1',
      model: 'gpt-4',
      plugins: [],
      provider: 'openai',
      systemRole: 'You are a helper',
    });
    mockPluginQuery.mockResolvedValue([]);
    mockGetLobehubSkillManifests.mockResolvedValue([]);
    mockGetComposioManifests.mockResolvedValue([]);
    mockResolveConnectorGovernance.mockResolvedValue(inactiveGovernance);
    service = new AiAgentService({} as any, 'test-user-id');
  });

  it('keeps per-user identity and unpatched builtin manifests when inactive', async () => {
    await service.execAgent({ agentId: 'agent-1', prompt: 'Hello' } as any);

    // Manifest advertisement runs under the invoking user's identity, using
    // the constructor-time services (no extra construction).
    expect(mockGetLobehubSkillManifests).toHaveBeenCalledWith('test-user-id');
    expect(mockGetComposioManifests).toHaveBeenCalledWith('test-user-id');
    expect(mockMarketCtor).toHaveBeenCalledTimes(1);
    expect(mockComposioCtor).toHaveBeenCalledTimes(1);

    // No org-mandate transform is handed to the tools engine.
    expect(engineParams().transformBuiltinManifest).toBeUndefined();

    // The discoverable builtin manifests are ingested untouched.
    const webBrowsing = operationManifestMap()['lobe-web-browsing'];
    expect(webBrowsing).toBeDefined();
    const search = webBrowsing.api.find((api: any) => api.name === 'search');
    expect(search.description).not.toContain('[TOOL DISABLED]');
  });

  it('patches builtin manifests from the org matrix and substitutes the shared owner', async () => {
    mockResolveConnectorGovernance.mockResolvedValue({
      active: true,
      builtinToolPolicies: {
        'lobe-web-browsing': { crawlSinglePage: 'needs_approval', search: 'disabled' },
      },
      sharedAuthOwnerUserId: 'org-owner',
    });

    await service.execAgent({ agentId: 'agent-1', prompt: 'Hello' } as any);

    // Skill/Composio manifests are advertised under the shared owner identity.
    expect(mockGetLobehubSkillManifests).toHaveBeenCalledWith('org-owner');
    expect(mockGetComposioManifests).toHaveBeenCalledWith('org-owner');
    expect(mockMarketCtor).toHaveBeenLastCalledWith({ userInfo: { userId: 'org-owner' } });
    expect(mockComposioCtor).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'org-owner' }),
    );

    // The engine receives the org-mandate transform, and it applies the matrix.
    const transform = engineParams().transformBuiltinManifest;
    expect(typeof transform).toBe('function');
    const patched = transform({
      api: [
        { description: 'd1', name: 'search' },
        { description: 'd2', name: 'crawlSinglePage' },
        { description: 'd3', name: 'crawlMultiPages' },
      ],
      identifier: 'lobe-web-browsing',
    });
    expect(patched.api[0].description).toContain('[TOOL DISABLED]');
    expect(patched.api[0].humanIntervention).toBe('required');
    expect(patched.api[1].humanIntervention).toBe('required');
    expect(patched.api[2]).toEqual({ description: 'd3', name: 'crawlMultiPages' });

    // The runtime-facing toolManifestMap (humanIntervention guard + activator
    // discovery) carries the same patch for ingested builtin manifests.
    const webBrowsing = operationManifestMap()['lobe-web-browsing'];
    expect(webBrowsing).toBeDefined();
    const search = webBrowsing.api.find((api: any) => api.name === 'search');
    expect(search.description).toContain('[TOOL DISABLED]');
    expect(search.humanIntervention).toBe('required');
    const crawl = webBrowsing.api.find((api: any) => api.name === 'crawlSinglePage');
    expect(crawl.humanIntervention).toBe('required');
  });

  it('does not substitute identity when the shared owner is the invoking user', async () => {
    mockResolveConnectorGovernance.mockResolvedValue({
      active: true,
      builtinToolPolicies: {},
      sharedAuthOwnerUserId: 'test-user-id',
    });

    await service.execAgent({ agentId: 'agent-1', prompt: 'Hello' } as any);

    expect(mockGetLobehubSkillManifests).toHaveBeenCalledWith('test-user-id');
    expect(mockMarketCtor).toHaveBeenCalledTimes(1);
    expect(mockComposioCtor).toHaveBeenCalledTimes(1);
  });
});
