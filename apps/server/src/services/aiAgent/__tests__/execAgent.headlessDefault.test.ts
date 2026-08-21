import type * as ModelBankModule from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiAgentService } from '../index';

const {
  mockCreateOperation,
  mockGetAgentConfig,
  mockMessageCreate,
  mockResolveEffectiveUserInterventionConfig,
  mockResolvePersonalTopicApprovalSnapshot,
  mockTopicCreate,
  mockTopicFindById,
} = vi.hoisted(() => ({
  mockCreateOperation: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockResolveEffectiveUserInterventionConfig: vi.fn(),
  mockResolvePersonalTopicApprovalSnapshot: vi.fn(),
  mockTopicCreate: vi.fn(),
  mockTopicFindById: vi.fn(),
}));

vi.mock('@/server/enterprise/services/settings/runtimeSettingsAdapter', () => ({
  getEffectiveMemorySettings: vi.fn().mockResolvedValue(undefined),
  resolveEffectiveUserInterventionConfig: mockResolveEffectiveUserInterventionConfig,
  resolvePersonalTopicApprovalSnapshot: mockResolvePersonalTopicApprovalSnapshot,
}));

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
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
  AgentService: vi.fn().mockImplementation(() => ({
    getAgentConfig: mockGetAgentConfig,
    queryAvailableAgents: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    create: mockTopicCreate,
    findById: mockTopicFindById,
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
  AgentRuntimeService: vi.fn().mockImplementation(() => ({
    createOperation: mockCreateOperation,
  })),
}));

vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn().mockImplementation(() => ({
    getLobehubSkillManifests: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/server/services/composio', () => ({
  ComposioService: vi.fn().mockImplementation(() => ({
    getComposioManifests: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    uploadFromUrl: vi.fn(),
  })),
}));

vi.mock('@/server/modules/Mecha', () => ({
  createServerAgentToolsEngine: vi.fn().mockReturnValue({
    generateToolsDetailed: vi.fn().mockReturnValue({ enabledToolIds: [], tools: [] }),
    getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
  }),
  serverMessagesEngine: vi.fn().mockResolvedValue([{ content: 'test', role: 'user' }]),
}));

vi.mock('@/server/services/deviceGateway', () => ({
  deviceGateway: {
    isConfigured: false,
    queryDeviceList: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn(),
}));

vi.mock('model-bank', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelBankModule>();
  return {
    ...actual,
    LOBE_DEFAULT_MODEL_LIST: [
      {
        abilities: { functionCall: true, video: false, vision: true },
        id: 'gpt-4',
        providerId: 'openai',
      },
    ],
  };
});

describe('AiAgentService.execAgent - headless approval default', () => {
  let service: AiAgentService;
  const mockDb = {} as any;
  const userId = 'test-user-id';

  beforeEach(() => {
    vi.clearAllMocks();
    mockTopicCreate.mockResolvedValue({ id: 'topic-1' });
    mockTopicFindById.mockResolvedValue(undefined);
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
      systemRole: '',
    });
    mockResolveEffectiveUserInterventionConfig.mockImplementation(
      async ({ callerConfig, topicApprovalMode }) => {
        if (!topicApprovalMode) return callerConfig;
        return { ...callerConfig, approvalMode: topicApprovalMode };
      },
    );
    mockResolvePersonalTopicApprovalSnapshot.mockImplementation(
      async ({ clientApprovalMode }) => clientApprovalMode ?? 'manual',
    );
    service = new AiAgentService(mockDb, userId);
  });

  it('should default to headless approval mode when userInterventionConfig is not provided', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      prompt: 'Hello',
    });

    expect(mockCreateOperation).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateOperation.mock.calls[0][0];
    expect(callArgs.userInterventionConfig).toEqual({ approvalMode: 'headless' });
  });

  it('should respect explicit userInterventionConfig when provided', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'manual' },
    });

    expect(mockCreateOperation).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateOperation.mock.calls[0][0];
    expect(callArgs.userInterventionConfig).toEqual({ approvalMode: 'manual' });
  });

  it('should respect explicit allow-list approval mode with allowList', async () => {
    const config = { allowList: ['tool-a', 'tool-b'], approvalMode: 'allow-list' as const };
    mockResolvePersonalTopicApprovalSnapshot.mockResolvedValueOnce('allow-list');

    await service.execAgent({
      agentId: 'agent-1',
      prompt: 'Hello',
      userInterventionConfig: config,
    });

    expect(mockCreateOperation).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateOperation.mock.calls[0][0];
    expect(callArgs.userInterventionConfig).toEqual(config);
  });

  it('enforces the trusted effective policy at the real execAgent boundary', async () => {
    mockResolveEffectiveUserInterventionConfig.mockResolvedValueOnce({ approvalMode: 'manual' });

    await service.execAgent({
      agentId: 'agent-1',
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'headless' },
    });

    expect(mockCreateOperation).toHaveBeenCalledTimes(1);
    expect(mockCreateOperation.mock.calls[0][0].userInterventionConfig).toEqual({
      approvalMode: 'manual',
    });
  });

  it('uses platform-only policy scope for workspace execution', async () => {
    service = new AiAgentService(mockDb, userId, { workspaceId: 'ws-1' });
    mockResolveEffectiveUserInterventionConfig.mockResolvedValueOnce({ approvalMode: 'manual' });

    await service.execAgent({
      agentId: 'agent-1',
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'auto-run' },
    });

    expect(mockResolveEffectiveUserInterventionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'workspace', userId }),
    );
    expect(mockCreateOperation.mock.calls[0][0].userInterventionConfig).toEqual({
      approvalMode: 'manual',
    });
  });

  it('loads topic.metadata.approvalMode and forwards it to the resolver', async () => {
    mockTopicFindById.mockResolvedValueOnce({
      id: 'topic-existing',
      metadata: { approvalMode: 'allow-list' },
    });

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { topicId: 'topic-existing' },
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'manual' },
    });

    expect(mockTopicFindById).toHaveBeenCalledWith('topic-existing');
    expect(mockResolveEffectiveUserInterventionConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        topicApprovalMode: 'allow-list',
        userId,
      }),
    );
  });

  it('snapshots the resolved approval mode onto a newly created topic', async () => {
    mockResolvePersonalTopicApprovalSnapshot.mockResolvedValueOnce('auto-run');

    await service.execAgent({
      agentId: 'agent-1',
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'auto-run' },
    });

    expect(mockTopicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ approvalMode: 'auto-run' }),
      }),
    );
  });

  it('uses initialTopicMetadata.approvalMode as the topic layer so the first run matches the snapshot', async () => {
    mockResolvePersonalTopicApprovalSnapshot.mockResolvedValueOnce('manual');

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { initialTopicMetadata: { approvalMode: 'manual' } },
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'auto-run' },
    });

    expect(mockResolvePersonalTopicApprovalSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ clientApprovalMode: 'manual', userId }),
    );
    expect(mockResolveEffectiveUserInterventionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ topicApprovalMode: 'manual' }),
    );
    expect(mockCreateOperation.mock.calls[0][0].userInterventionConfig.approvalMode).toBe('manual');
    expect(mockTopicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ approvalMode: 'manual' }),
      }),
    );
  });

  it('does not snapshot when a locked headless policy wins the first run', async () => {
    mockResolvePersonalTopicApprovalSnapshot.mockResolvedValueOnce(undefined);
    mockResolveEffectiveUserInterventionConfig.mockResolvedValueOnce({ approvalMode: 'headless' });

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { initialTopicMetadata: { approvalMode: 'auto-run' } },
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'auto-run' },
    });

    expect(mockResolvePersonalTopicApprovalSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ clientApprovalMode: 'auto-run', userId }),
    );
    expect(mockCreateOperation.mock.calls[0][0].userInterventionConfig.approvalMode).toBe(
      'headless',
    );
    expect(mockTopicCreate.mock.calls[0][0].metadata).toEqual(
      expect.not.objectContaining({ approvalMode: expect.anything() }),
    );
  });

  it('lets a locked snapshot override client-supplied initial metadata on the first run', async () => {
    mockResolvePersonalTopicApprovalSnapshot.mockResolvedValueOnce('manual');

    await service.execAgent({
      agentId: 'agent-1',
      appContext: { initialTopicMetadata: { approvalMode: 'auto-run' } },
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'auto-run' },
    });

    expect(mockResolvePersonalTopicApprovalSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ clientApprovalMode: 'auto-run', userId }),
    );
    expect(mockCreateOperation.mock.calls[0][0].userInterventionConfig.approvalMode).toBe('manual');
    expect(mockTopicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ approvalMode: 'manual' }),
      }),
    );
  });

  it('does not snapshot headless onto a newly created topic', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      prompt: 'Hello',
    });

    expect(mockResolvePersonalTopicApprovalSnapshot).not.toHaveBeenCalled();
    expect(mockTopicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: undefined,
      }),
    );
  });

  it('does not snapshot when a headless caller supplies initialTopicMetadata.approvalMode', async () => {
    await service.execAgent({
      agentId: 'agent-1',
      appContext: { initialTopicMetadata: { approvalMode: 'auto-run', repos: ['org/repo'] } },
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'headless' },
    });

    expect(mockResolvePersonalTopicApprovalSnapshot).not.toHaveBeenCalled();
    expect(mockResolveEffectiveUserInterventionConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        callerConfig: { approvalMode: 'headless' },
        topicApprovalMode: undefined,
      }),
    );
    expect(mockTopicCreate.mock.calls[0][0].metadata).toEqual(
      expect.not.objectContaining({ approvalMode: expect.anything() }),
    );
    expect(mockTopicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ repos: ['org/repo'] }),
      }),
    );
  });

  it('does not snapshot when a headless caller is transformed to an interactive mode by policy', async () => {
    mockResolveEffectiveUserInterventionConfig.mockResolvedValueOnce({ approvalMode: 'manual' });

    await service.execAgent({
      agentId: 'agent-1',
      prompt: 'Hello',
      userInterventionConfig: { approvalMode: 'headless' },
    });

    expect(mockResolvePersonalTopicApprovalSnapshot).not.toHaveBeenCalled();
    expect(mockCreateOperation.mock.calls[0][0].userInterventionConfig).toEqual({
      approvalMode: 'manual',
    });
    expect(mockTopicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: undefined,
      }),
    );
  });
});
