/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SendButtonHandler } from '@/features/ChatInput/store/initialState';

import { useSend } from './useSend';

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

const sendMessageMock = vi.hoisted(() => vi.fn());
const clearContentMock = vi.hoisted(() => vi.fn());
const clearChatUploadFileListMock = vi.hoisted(() => vi.fn());
const clearChatContextSelectionsMock = vi.hoisted(() => vi.fn());

const chatState = vi.hoisted(() => ({
  activeAgentId: undefined as string | undefined,
  activeThreadId: undefined as string | null | undefined,
  activeTopicId: undefined as string | null | undefined,
  dbMessagesMap: {} as Record<string, { id: string; role: string }[]>,
  inputMessage: 'hello',
  mainInputEditor: {
    clearContent: clearContentMock,
    getJSONState: vi.fn(() => ({ type: 'doc' })),
  },
  sendMessage: sendMessageMock,
}));

const fileState = vi.hoisted(() => ({
  chatContextSelections: [] as any[],
  chatUploadFileList: [],
  clearChatContextSelections: clearChatContextSelectionsMock,
  clearChatUploadFileList: clearChatUploadFileListMock,
}));

const homeState = vi.hoisted(() => ({
  agentGroups: [],
  homeInputLoading: false,
  inputActiveMode: null as any,
  isAgentListInit: true,
  pinnedAgents: [],
  privateAgentGroups: [],
  privateUngroupedAgents: [],
  sendAsAgent: vi.fn(),
  sendAsGroup: vi.fn(),
  sendAsResearch: vi.fn(),
  sendAsWrite: vi.fn(),
  ungroupedAgents: [],
}));

const agentState = vi.hoisted(() => ({
  activeAgentId: undefined as string | undefined,
  agentMap: {
    agt_inbox: {},
  },
  inboxAgentId: 'agt_inbox',
  internal_dispatchAgentMap: vi.fn(),
}));

const globalState = vi.hoisted(() => ({
  systemStatus: {
    homeSelectedAgentId: undefined,
  },
  updateSystemStatus: vi.fn(),
}));

const homeDailyBriefState = vi.hoisted(() => ({
  advance: vi.fn(),
  currentIndex: 0,
  currentPair: undefined as { hint: string; welcome: string } | undefined,
  pairs: [] as { hint: string; welcome: string }[],
}));

const activeWorkspaceSlugMock = vi.hoisted(() => ({
  value: null as string | null,
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => activeWorkspaceSlugMock.value,
}));

vi.mock('@/hooks/useQueryRoute', () => ({
  useQueryRoute: () => routerMock,
}));

vi.mock('@/hooks/useHomeDailyBrief', () => ({
  useHomeDailyBrief: () => homeDailyBriefState,
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: Object.assign(
    (selector: (state: typeof agentState) => unknown) => selector(agentState),
    {
      getState: () => agentState,
      setState: (partial: Partial<typeof agentState>) => Object.assign(agentState, partial),
    },
  ),
}));

vi.mock('@/store/agent/selectors', () => ({
  builtinAgentSelectors: {
    inboxAgentId: (state: typeof agentState) => state.inboxAgentId,
  },
}));

vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (state: typeof globalState) => unknown) => selector(globalState),
}));

vi.mock('@/store/global/selectors', () => ({
  systemStatusSelectors: {
    homeSelectedAgentId: (state: typeof globalState) => state.systemStatus.homeSelectedAgentId,
  },
}));

vi.mock('@/store/chat', () => {
  const useChatStore = Object.assign(
    (selector: (state: typeof chatState) => unknown) => selector(chatState),
    {
      getState: () => chatState,
      setState: (partial: Partial<typeof chatState>) => Object.assign(chatState, partial),
    },
  );

  return { useChatStore };
});

vi.mock('@/store/file', () => {
  const useFileStore = (selector: (state: typeof fileState) => unknown) => selector(fileState);
  useFileStore.getState = () => fileState;

  return {
    fileChatSelectors: {
      chatContextSelections: (state: typeof fileState) => state.chatContextSelections,
      chatUploadFileList: (state: typeof fileState) => state.chatUploadFileList,
    },
    useFileStore,
  };
});

vi.mock('@/store/home', () => {
  const useHomeStore = (selector: (state: typeof homeState) => unknown) => selector(homeState);
  useHomeStore.getState = () => homeState;

  return { useHomeStore };
});

describe('Home InputArea useSend', () => {
  beforeEach(() => {
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
    sendMessageMock.mockReset();
    clearContentMock.mockReset();
    clearChatUploadFileListMock.mockReset();
    clearChatContextSelectionsMock.mockReset();
    homeDailyBriefState.advance.mockReset();
    homeDailyBriefState.currentPair = undefined;
    chatState.inputMessage = 'hello';
    fileState.chatContextSelections = [];
    fileState.chatUploadFileList = [];
    homeState.inputActiveMode = null;
    activeWorkspaceSlugMock.value = null;
    chatState.activeAgentId = undefined;
    chatState.activeThreadId = 'thd_stale';
    chatState.activeTopicId = 'tpc_stale';
    chatState.dbMessagesMap = {};
    agentState.activeAgentId = undefined;
  });

  const expectNoAgentPathname = () => {
    for (const [url] of [...routerMock.push.mock.calls, ...routerMock.replace.mock.calls]) {
      expect(url).not.toMatch(/^\/(?:[^/?#]+\/)?agent\//);
    }
  };

  it('opens the cold homepage send in place instead of navigating to the agent route', async () => {
    const { result } = renderHook(() => useSend());
    const params: Parameters<SendButtonHandler>[0] = {
      clearContent: vi.fn(),
      editor: {} as Parameters<SendButtonHandler>[0]['editor'],
      getEditorData: () => undefined,
      getMarkdownContent: () => 'hello',
    };

    await act(async () => {
      await result.current.send(params);
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { agentId: 'agt_inbox', isolatedTopic: true },
        message: 'hello',
        onTopicCreated: expect.any(Function),
      }),
    );
    // Navigate immediately — the conversation surface has to swap in while the
    // optimistic messages stream, well before the topic exists.
    expect(routerMock.push).toHaveBeenCalledWith('/?agent=agt_inbox', { replace: true });

    const sentPayload = sendMessageMock.mock.calls[0][0];

    await act(async () => {
      await sentPayload.onTopicCreated('tpc_created');
    });

    expect(routerMock.replace).toHaveBeenCalledWith('/?agent=agt_inbox&topic=tpc_created', {
      replace: true,
    });
    expectNoAgentPathname();
  });

  it('seeds both stores and the optimistic messages before opening the column', async () => {
    const order: string[] = [];
    routerMock.push.mockImplementation(() => {
      order.push('push');
    });
    sendMessageMock.mockImplementation(
      async ({
        context,
        onOptimisticReady,
      }: {
        context: { agentId: string };
        onOptimisticReady?: () => void;
      }) => {
        // A real `sendMessage` seeds synchronously, but the desktop branch can
        // await before it — assert `useSend` waits for the signal, not for luck.
        await Promise.resolve();

        // Both stores must already carry the conversation identity by the time
        // the send starts: `useAgentContext` reads the CHAT store, and the
        // right column's very first render keys on it.
        expect(chatState.activeAgentId).toBe('agt_inbox');
        expect(chatState.activeTopicId).toBeUndefined();
        expect(chatState.activeThreadId).toBeUndefined();
        expect(agentState.activeAgentId).toBe('agt_inbox');

        chatState.dbMessagesMap[`main_${context.agentId}_new`] = [
          { id: 'tmp_user', role: 'user' },
          { id: 'tmp_assistant', role: 'assistant' },
        ];
        order.push('optimistic');
        onOptimisticReady?.();

        // Persist + stream keep running long after the column has swapped.
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push('persisted');
      },
    );

    const { result } = renderHook(() => useSend());
    const params: Parameters<SendButtonHandler>[0] = {
      clearContent: vi.fn(),
      editor: {} as Parameters<SendButtonHandler>[0]['editor'],
      getEditorData: () => undefined,
      getMarkdownContent: () => 'hello',
    };

    await act(async () => {
      await result.current.send(params);
    });

    // Never before the bubbles exist, never after the topic is persisted.
    expect(order).toEqual(['optimistic', 'push']);
    expect(chatState.dbMessagesMap['main_agt_inbox_new']).toHaveLength(2);
    expect(routerMock.push).toHaveBeenCalledWith('/?agent=agt_inbox', { replace: true });
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onOptimisticReady: expect.any(Function),
        registerCreatedTopic: true,
      }),
    );
  });

  it('still opens the column when the send bails out before seeding anything', async () => {
    // e.g. the context is busy and the message is queued instead of sent —
    // `onOptimisticReady` never fires, so the push must fall back to the
    // settled send promise rather than hang the navigation.
    sendMessageMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSend());
    const params: Parameters<SendButtonHandler>[0] = {
      clearContent: vi.fn(),
      editor: {} as Parameters<SendButtonHandler>[0]['editor'],
      getEditorData: () => undefined,
      getMarkdownContent: () => 'hello',
    };

    await act(async () => {
      await result.current.send(params);
    });

    expect(routerMock.push).toHaveBeenCalledWith('/?agent=agt_inbox', { replace: true });
  });

  it('opens the column even when the send rejects', async () => {
    sendMessageMock.mockRejectedValue(new Error('catalog unavailable'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useSend());
    const params: Parameters<SendButtonHandler>[0] = {
      clearContent: vi.fn(),
      editor: {} as Parameters<SendButtonHandler>[0]['editor'],
      getEditorData: () => undefined,
      getMarkdownContent: () => 'hello',
    };

    await act(async () => {
      await result.current.send(params);
    });

    expect(routerMock.push).toHaveBeenCalledWith('/?agent=agt_inbox', { replace: true });
    consoleSpy.mockRestore();
  });

  it('captures the active workspace slug in default homepage sends', async () => {
    activeWorkspaceSlugMock.value = 'team';
    const { result } = renderHook(() => useSend());
    const params: Parameters<SendButtonHandler>[0] = {
      clearContent: vi.fn(),
      editor: {} as Parameters<SendButtonHandler>[0]['editor'],
      getEditorData: () => undefined,
      getMarkdownContent: () => 'hello',
    };

    await act(async () => {
      await result.current.send(params);
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { agentId: 'agt_inbox', isolatedTopic: true, workspaceSlug: 'team' },
      }),
    );
    // The URL handed to `useQueryRoute` stays root-relative — the workspace
    // prefix (`/team/?agent=…`) is applied by `useWorkspaceAwareNavigate`.
    expect(routerMock.push).toHaveBeenCalledWith('/?agent=agt_inbox', { replace: true });

    const sentPayload = sendMessageMock.mock.calls[0][0];

    await act(async () => {
      await sentPayload.onTopicCreated('tpc_created');
    });

    expect(routerMock.replace).toHaveBeenCalledWith('/?agent=agt_inbox&topic=tpc_created', {
      replace: true,
    });
    expectNoAgentPathname();
  });

  it('drops editorData when sending the placeholder hint so the user message renders the markdown content', async () => {
    homeDailyBriefState.currentPair = {
      hint: '看下 Bug #14153 + #14112 Agent 手机端不同步/不显示...',
      welcome: 'welcome',
    };
    chatState.inputMessage = '';

    const { result } = renderHook(() => useSend());
    const params: Parameters<SendButtonHandler>[0] = {
      clearContent: vi.fn(),
      editor: {} as Parameters<SendButtonHandler>[0]['editor'],
      // Empty editor still returns a non-null JSON state; this would
      // previously be forwarded as editorData and blank the rendered
      // user bubble.
      getEditorData: () => ({ type: 'doc' }),
      getMarkdownContent: () => '',
    };

    await act(async () => {
      await result.current.send(params);
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const sentPayload = sendMessageMock.mock.calls[0][0];
    expect(sentPayload.message).toBe('看下 Bug #14153 + #14112 Agent 手机端不同步/不显示');
    expect(sentPayload.editorData).toBeUndefined();
    expect(homeDailyBriefState.advance).toHaveBeenCalledTimes(1);
  });

  it('passes context selections through starter agent mode sends', async () => {
    homeState.inputActiveMode = 'agent';
    activeWorkspaceSlugMock.value = 'team';
    fileState.chatContextSelections = [
      {
        content: 'const selected = true;',
        filePath: 'src/example.ts',
        id: 'code-selection',
        lineRange: { endLine: 12, startLine: 10 },
        preview: 'src/example.ts:10-12',
        source: 'code',
        title: 'src/example.ts:10-12',
        workingDirectory: '/repo',
      },
    ];

    const { result } = renderHook(() => useSend());
    const params: Parameters<SendButtonHandler>[0] = {
      clearContent: vi.fn(),
      editor: {} as Parameters<SendButtonHandler>[0]['editor'],
      getEditorData: () => ({ type: 'doc' }),
      getMarkdownContent: () => 'use this selection',
    };

    await act(async () => {
      await result.current.send(params);
    });

    expect(homeState.sendAsAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSelections: [
          expect.objectContaining({
            content: 'const selected = true;',
            filePath: 'src/example.ts',
            lineRange: { endLine: 12, startLine: 10 },
            source: 'code',
          }),
        ],
        message: 'use this selection',
        workspaceSlug: 'team',
      }),
    );
    expect(clearChatContextSelectionsMock).toHaveBeenCalledTimes(1);
  });
});
