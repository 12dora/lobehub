import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chatService } from '@/services/chat';
import { messageService } from '@/services/message';
import { messageOptimisticUpdate } from '@/store/chat/slices/message/actions/optimisticUpdate';

import { createCallLLMInstruction, createMockStore, createUserMessage } from './fixtures';
import { createInitialState, createTestContext, executeWithMockContext } from './helpers';

vi.mock('@/services/chat', () => ({
  chatService: {
    createAssistantMessageStream: vi.fn(),
  },
}));

// The ONLY boundary mocked for the persistence assertions: the trpc-backed message service.
// Everything between the executor and this call is the real store action.
vi.mock('@/services/message', () => ({
  messageService: {
    addFilesToMessage: vi.fn(),
    updateMessage: vi.fn(),
  },
}));

vi.mock('@/components/AntdStaticMethods', () => ({
  message: { error: vi.fn(), info: vi.fn() },
  notification: { error: vi.fn() },
}));

vi.mock('@/store/chat/selectors', () => ({
  topicSelectors: {
    currentActiveTopicSummary: vi.fn().mockReturnValue(undefined),
  },
}));

vi.mock('@/store/file/store', () => ({
  getFileStoreState: vi.fn().mockReturnValue({
    uploadBase64FileWithProgress: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {},
}));

vi.mock('@/store/agent/store', () => ({
  getAgentStoreState: vi.fn().mockReturnValue({}),
}));

const moderation = {
  action: 'downgrade' as const,
  category: 'jailbreak',
  message: 'Policy: switched to {{model}}',
  model: 'safe-model',
  originalModel: 'gpt-4',
  originalProvider: 'openai',
  provider: 'safe-provider',
  recordId: 'record-1',
};

interface UpdateMessageCall {
  id: string;
  params: {
    content?: string;
    metadata?: Record<string, any>;
    model?: string;
    provider?: string;
  };
}

const runCallLlm = async (finishContext: Record<string, unknown>) => {
  const conversationContext = {
    agentId: 'test-session',
    groupId: undefined,
    topicId: 'test-topic',
  };

  const mockStore = createMockStore({
    internal_getConversationContext: vi.fn().mockReturnValue(conversationContext),
    refreshMessages: vi.fn(),
    replaceMessages: vi.fn(),
  } as any);

  // Swap the fixture's `vi.fn()` stub for the REAL store action, so the test exercises
  // optimisticUpdateMessageContent → messageService.updateMessage → replaceMessages instead of
  // asserting an internal mock call. `set` is unused by this action.
  const realMessageActions = messageOptimisticUpdate(vi.fn() as any, () => mockStore);
  (mockStore as any).optimisticUpdateMessageContent =
    realMessageActions.optimisticUpdateMessageContent;

  // Stand in for the DB round-trip: echo the persisted row back the way the server does.
  vi.mocked(messageService.updateMessage).mockImplementation(
    async (id: string, params: any) => ({ messages: [{ id, ...params }], success: true }) as any,
  );

  const context = createTestContext({ agentId: 'test-session', topicId: 'test-topic' });

  vi.mocked(chatService.createAssistantMessageStream).mockImplementation(async (params: any) => {
    await params.onMessageHandle?.({ text: 'AI response', type: 'text' });
    await params.onFinish?.('AI response', { type: 'stop', ...finishContext });
  });

  mockStore.dbMessagesMap[context.messageKey] = [];

  await executeWithMockContext({
    context,
    executor: 'call_llm',
    instruction: createCallLLMInstruction({
      messages: [createUserMessage()],
      model: 'gpt-4',
      provider: 'openai',
    }),
    mockStore,
    state: createInitialState({ operationId: 'test-session' }),
  });

  const updateCalls: UpdateMessageCall[] = vi
    .mocked(messageService.updateMessage)
    .mock.calls.map(([id, params]: any) => ({ id, params }));

  return { mockStore, updateCalls };
};

describe('call_llm executor — 内容审计 downgrade metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the moderation metadata and the effective model / provider', async () => {
    const { mockStore, updateCalls } = await runCallLlm({ moderation });

    // What actually reaches the persistence boundary.
    const contentUpdate = updateCalls.find((call) => call.params.content !== undefined);
    expect(contentUpdate?.params).toMatchObject({
      metadata: expect.objectContaining({ moderation }),
      model: 'safe-model',
      provider: 'safe-provider',
    });

    // …and what the store gets back from that write (the row the UI renders from).
    const replaced = vi.mocked(mockStore.replaceMessages).mock.calls.at(-1)?.[0] as any[];
    expect(replaced?.[0]).toMatchObject({
      metadata: expect.objectContaining({ moderation }),
      model: 'safe-model',
      provider: 'safe-provider',
    });
  });

  it('keeps the moderation metadata alongside the usage / performance metadata', async () => {
    const { updateCalls } = await runCallLlm({
      moderation,
      usage: { inputTextTokens: 10, totalTokens: 42 },
    });

    const contentUpdate = updateCalls.find((call) => call.params.content !== undefined);
    const metadata = contentUpdate?.params.metadata ?? {};

    expect(metadata.moderation).toEqual(moderation);
    // The moderation key must not displace the usage payload written in the same object.
    expect(metadata.usage).toBeDefined();
    expect(metadata.totalTokens).toBe(42);
  });

  it('leaves the message untouched when the response was not downgraded', async () => {
    const { updateCalls } = await runCallLlm({});

    const contentUpdate = updateCalls.find((call) => call.params.content !== undefined);

    expect(contentUpdate?.params.metadata?.moderation).toBeUndefined();
    expect(contentUpdate?.params.model).toBeUndefined();
    expect(contentUpdate?.params.provider).toBeUndefined();
  });
});
