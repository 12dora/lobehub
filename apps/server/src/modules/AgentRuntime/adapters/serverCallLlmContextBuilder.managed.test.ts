/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServerCallLlmContext } from './serverCallLlmContextBuilder';

const { serverMessagesEngine } = vi.hoisted(() => ({
  serverMessagesEngine: vi.fn(async (input: { messages: unknown[] }) => input.messages),
}));

vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine }));

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
