/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServerCallLlmContext } from './serverCallLlmContextBuilder';

const {
  findPlatformOperationRef,
  isPlatformManagedAiEnabled,
  resolvePlatformAiExecutionConfig,
  resolvePlatformAiExecutionConfigAtRevision,
  serverMessagesEngine,
} = vi.hoisted(() => ({
  findPlatformOperationRef: vi.fn(),
  isPlatformManagedAiEnabled: vi.fn(() => true),
  resolvePlatformAiExecutionConfig: vi.fn(),
  resolvePlatformAiExecutionConfigAtRevision: vi.fn(),
  serverMessagesEngine: vi.fn(async (input: { messages: unknown[] }) => input.messages),
}));

vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine }));

vi.mock('@/server/modules/ModelRuntime/platformAiRuntimeBridge', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isPlatformManagedAiEnabled,
    resolvePlatformAiExecutionConfig,
    resolvePlatformAiExecutionConfigAtRevision,
  };
});

vi.mock('@/database/models/agentOperation', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    AgentOperationModel: class {
      findPlatformOperationRef = findPlatformOperationRef;
    },
  };
});

vi.mock('./serverCallLlmContextHints', () => ({
  resolveServerCallLlmContextHints: vi.fn(async ({ llmPayload }) => ({
    capabilities: { vision: true },
    messagesForContext: llmPayload.messages,
    modelDisplayName: 'Exact model',
    modelKnowledgeCutoff: '2025-01',
    preserveThinkingForPayload: false,
    resolvedExtendParams: undefined,
    shouldReplayAssistantReasoning: false,
  })),
}));

const messages = [{ content: 'hello', role: 'user' }];
const initialContext = { initialContext: { mentionedAgents: [{ id: 'dynamic-mentioned' }] } };
const dynamicMetadata = {
  agentConfig: { title: 'Dynamic title' },
  agentGroup: { agents: [{ id: 'dynamic-group-agent' }] },
  agentId: 'dynamic-agent-id',
  deviceSystemInfo: { device_name: 'dynamic-device' },
  userMemory: { memories: { contexts: [{ content: 'dynamic-memory' }] } },
};
const dynamicCtx = {
  agentConfig: {
    chatConfig: {},
    files: [],
    knowledgeBases: [],
    systemRole: 'audited exact system role',
  },
  botPlatformContext: { botUserId: 'dynamic-bot' },
  discordContext: { guildId: 'dynamic-guild' },
  evalContext: { envPrompt: 'dynamic-eval-prompt' },
  operationId: 'op-managed',
  stepIndex: 0,
  tracingContextEngine: vi.fn(),
  userTimezone: 'Asia/Singapore',
};
const tooling = {
  resolved: {
    enabledToolIds: ['exact-tool'],
    promptManifestMap: {
      'exact-tool': { identifier: 'exact-tool', meta: { title: 'Exact tool' } },
    },
  },
};

describe('buildServerCallLlmContext — managed exact prompt boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shields every mutable runtime prompt context at the final MessagesEngine boundary', async () => {
    await buildServerCallLlmContext({
      ctx: dynamicCtx as never,
      llmPayload: { messages } as never,
      model: 'exact-model',
      provider: 'exact-provider',
      state: {
        initialContext,
        metadata: { ...dynamicMetadata, platformStartClassification: 'complete' },
      } as never,
      tooling: tooling as never,
    });

    const input = serverMessagesEngine.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toEqual(
      expect.objectContaining({
        additionalVariables: {},
        agentGroup: undefined,
        agentManagementContext: undefined,
        botPlatformContext: undefined,
        discordContext: undefined,
        evalContext: undefined,
        initialContext: undefined,
        systemRole: 'audited exact system role',
        userMemory: undefined,
        userTimezone: undefined,
      }),
    );
    expect(input).not.toHaveProperty('agentBuilderContext');
    expect(input).not.toHaveProperty('onboardingContext');
    expect(input).not.toHaveProperty('topicReferences');
  });

  it('leaves the ordinary operation context behavior unchanged', async () => {
    await buildServerCallLlmContext({
      ctx: dynamicCtx as never,
      llmPayload: { messages } as never,
      model: 'ordinary-model',
      provider: 'ordinary-provider',
      state: {
        initialContext,
        metadata: { ...dynamicMetadata, platformStartClassification: 'ordinary' },
      } as never,
      tooling: tooling as never,
    });

    const input = serverMessagesEngine.mock.calls[0][0] as Record<string, unknown>;
    expect(input.agentGroup).toEqual(dynamicMetadata.agentGroup);
    expect(input.agentManagementContext).toEqual({
      mentionedAgents: [{ id: 'dynamic-mentioned' }],
    });
    expect(input.additionalVariables).toEqual(
      expect.objectContaining({
        agent_id: 'dynamic-agent-id',
        device_name: 'dynamic-device',
      }),
    );
    expect(input.botPlatformContext).toEqual(dynamicCtx.botPlatformContext);
    expect(input.discordContext).toEqual(dynamicCtx.discordContext);
    expect(input.evalContext).toEqual(dynamicCtx.evalContext);
    expect(input.initialContext).toEqual(initialContext.initialContext);
    expect(input.userMemory).toEqual(dynamicMetadata.userMemory);
    expect(input.userTimezone).toBe('Asia/Singapore');
  });
});

const cursorPin = {
  modelKey: 'composer-2.5',
  providerChecksum: 'a'.repeat(64),
  providerKey: 'corp-cursor',
  providerRevision: 1,
};
const cursorPlatformStart = {
  assistantMessageId: 'asst-1',
  platformConnectors: [],
  platformModel: cursorPin,
  platformOperation: {
    checksum: 'b'.repeat(64),
    platformAgentId: 'pagt-1',
    versionId: 'pav-1',
  },
  platformSkills: [],
};

describe('buildServerCallLlmContext — runtime provider classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPlatformManagedAiEnabled.mockReturnValue(true);
    findPlatformOperationRef.mockResolvedValue({
      classification: 'ordinary',
      isPlatformOperation: false,
      modelPin: null,
      platformStart: null,
    });
  });

  it('resolves a complete platform op from its pinned Cursor revision after the current runtime or feature flag changes', async () => {
    isPlatformManagedAiEnabled.mockReturnValue(false);
    resolvePlatformAiExecutionConfig.mockResolvedValue({ runtimeProvider: 'openai' });
    resolvePlatformAiExecutionConfigAtRevision.mockResolvedValue({ runtimeProvider: 'cursor' });
    findPlatformOperationRef.mockResolvedValue({
      classification: 'complete',
      isPlatformOperation: true,
      modelPin: cursorPin,
      platformStart: cursorPlatformStart,
    });

    await buildServerCallLlmContext({
      ctx: {
        ...dynamicCtx,
        serverDB: {},
        userId: 'user-a',
      } as never,
      llmPayload: { messages } as never,
      model: 'composer-2.5',
      provider: 'corp-cursor',
      state: {
        metadata: {
          ...dynamicMetadata,
          platformStartBinding: cursorPlatformStart,
          platformStartClassification: 'complete',
        },
      } as never,
      tooling: tooling as never,
    });

    expect(resolvePlatformAiExecutionConfig).not.toHaveBeenCalled();
    expect(resolvePlatformAiExecutionConfigAtRevision).toHaveBeenCalledWith({}, cursorPin);
    expect(serverMessagesEngine.mock.calls[0][0]).toEqual(
      expect.objectContaining({ runtimeProvider: 'cursor' }),
    );
  });

  it('propagates catalog resolution errors other than PLATFORM_NOT_FOUND', async () => {
    resolvePlatformAiExecutionConfig.mockRejectedValue(new Error('db down'));

    await expect(
      buildServerCallLlmContext({
        ctx: {
          ...dynamicCtx,
          serverDB: {},
          userId: 'user-a',
        } as never,
        llmPayload: { messages } as never,
        model: 'gpt-4o',
        provider: 'corp-cursor',
        state: {
          metadata: { ...dynamicMetadata, platformStartClassification: 'ordinary' },
        } as never,
        tooling: tooling as never,
      }),
    ).rejects.toThrow('db down');

    expect(serverMessagesEngine).not.toHaveBeenCalled();
  });

  it('treats PLATFORM_NOT_FOUND as unmanaged BYOK fallback', async () => {
    resolvePlatformAiExecutionConfig.mockRejectedValue(
      Object.assign(new Error('PLATFORM_NOT_FOUND'), { code: 'PLATFORM_NOT_FOUND' }),
    );

    await buildServerCallLlmContext({
      ctx: {
        ...dynamicCtx,
        serverDB: {},
        userId: 'user-a',
      } as never,
      llmPayload: { messages } as never,
      model: 'gpt-4o',
      provider: 'openai',
      state: {
        metadata: { ...dynamicMetadata, platformStartClassification: 'ordinary' },
      } as never,
      tooling: tooling as never,
    });

    expect(serverMessagesEngine.mock.calls[0][0]).toEqual(
      expect.objectContaining({ runtimeProvider: undefined }),
    );
  });
});
