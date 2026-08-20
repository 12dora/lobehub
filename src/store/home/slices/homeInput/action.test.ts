import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeStore } from '@/store/home/store';
import type { StoreSetter } from '@/store/types';

import { HomeInputActionImpl } from './action';

const navigateMock = vi.hoisted(() => vi.fn());
const createAgentMock = vi.hoisted(() => vi.fn());
const updateAgentConfigByIdMock = vi.hoisted(() => vi.fn());
const refreshBuiltinAgentMock = vi.hoisted(() => vi.fn());
const sendMessageMock = vi.hoisted(() => vi.fn());
const refreshAgentListMock = vi.hoisted(() => vi.fn());
const toggleAgentBuilderPanelMock = vi.hoisted(() => vi.fn());
const toggleRightPanelMock = vi.hoisted(() => vi.fn());
const setChatPanelExpandedMock = vi.hoisted(() => vi.fn());
const createGroupMock = vi.hoisted(() => vi.fn());
const loadGroupsMock = vi.hoisted(() => vi.fn());
const createDocumentMock = vi.hoisted(() => vi.fn());

const agentState = vi.hoisted(() => ({
  agentConfigMap: {
    agentBuilder: {
      chatConfig: {} as Record<string, unknown>,
      model: 'gpt-4o-mini',
      provider: 'openai',
    },
    groupAgentBuilder: {
      chatConfig: {} as Record<string, unknown>,
      model: 'gpt-4o-mini',
      provider: 'openai',
    },
    inbox: {
      chatConfig: {} as Record<string, unknown>,
      model: 'gpt-4o-mini',
      provider: 'openai',
    },
  },
  agentMap: {
    agentBuilder: {},
    groupAgentBuilder: {},
    pageAgent: {},
  },
  builtinAgentIdMap: {
    'agent-builder': 'agentBuilder',
    'group-agent-builder': 'groupAgentBuilder',
    'page-agent': 'pageAgent',
  },
  createAgent: createAgentMock,
  inboxAgentId: 'inbox',
  refreshBuiltinAgent: refreshBuiltinAgentMock,
  updateAgentConfigById: updateAgentConfigByIdMock,
}));

vi.mock('@lobechat/builtin-agents', () => ({
  BUILTIN_AGENT_SLUGS: {
    agentBuilder: 'agent-builder',
    groupAgentBuilder: 'group-agent-builder',
    pageAgent: 'page-agent',
  },
}));

vi.mock('@/services/document', () => ({
  documentService: {
    createDocument: createDocumentMock,
  },
}));

vi.mock('@/services/chatGroup', () => ({
  chatGroupService: {
    createGroup: createGroupMock,
  },
}));

vi.mock('@/store/agent', () => ({
  getAgentStoreState: () => agentState,
}));

vi.mock('@/store/agent/selectors', () => ({
  agentSelectors: {
    getAgentConfigById:
      (id: string) =>
      (
        state: typeof agentState,
      ): { chatConfig?: Record<string, unknown>; model: string; provider: string } | undefined =>
        state.agentConfigMap[id as keyof typeof state.agentConfigMap],
  },
  builtinAgentSelectors: {
    inboxAgentId: (state: typeof agentState) => state.inboxAgentId,
  },
}));

vi.mock('@/store/agentGroup', () => ({
  getChatGroupStoreState: () => ({
    loadGroups: loadGroupsMock,
  }),
}));

vi.mock('@/store/chat', () => ({
  useChatStore: {
    getState: () => ({
      sendMessage: sendMessageMock,
    }),
    setState: vi.fn(),
  },
}));

vi.mock('@/store/global', () => ({
  useGlobalStore: {
    getState: () => ({
      toggleAgentBuilderPanel: toggleAgentBuilderPanelMock,
      toggleRightPanel: toggleRightPanelMock,
    }),
  },
}));

vi.mock('@/store/groupProfile', () => ({
  useGroupProfileStore: {
    getState: () => ({
      setChatPanelExpanded: setChatPanelExpandedMock,
    }),
  },
}));

vi.mock('@/utils/stableNavigate', () => ({
  getStableNavigate: () => navigateMock,
}));

const createAction = () => {
  const homeState: Partial<HomeStore> = {
    refreshAgentList: refreshAgentListMock,
  };

  const setState: StoreSetter<HomeStore> = ((partial) => {
    if (typeof partial === 'function') {
      Object.assign(homeState, partial(homeState as HomeStore));
      return;
    }
    Object.assign(homeState, partial);
  }) as StoreSetter<HomeStore>;

  return new HomeInputActionImpl(setState, () => homeState as HomeStore);
};

describe('HomeInputActionImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentState.agentConfigMap.inbox.chatConfig = {};
    agentState.agentConfigMap.agentBuilder.chatConfig = {};
    agentState.agentConfigMap.groupAgentBuilder.chatConfig = {};
    // The store action writes through `updateAgentConfigById`; mirror the merge onto the
    // mock builder rows so a second create-with-AI run sees the first run's state.
    updateAgentConfigByIdMock.mockImplementation((id: string, config: Record<string, any>) => {
      const row = agentState.agentConfigMap[id as keyof typeof agentState.agentConfigMap];
      if (!row || !config.chatConfig) return;
      Object.assign(row.chatConfig, config.chatConfig);
    });
    createAgentMock.mockResolvedValue({ agentId: 'agent-new' });
    createGroupMock.mockResolvedValue({
      group: {
        id: 'group-new',
      },
    });
    createDocumentMock.mockResolvedValue({ id: 'doc-new' });
  });

  describe('sendAsAgent', () => {
    it('opens the agent builder panel without touching the generic right panel', async () => {
      const action = createAction();

      await action.sendAsAgent({ message: 'build a support agent' });

      expect(toggleAgentBuilderPanelMock).toHaveBeenCalledWith(true);
      expect(toggleRightPanelMock).not.toHaveBeenCalled();
      expect(navigateMock).toHaveBeenCalledWith('/agent/agent-new/profile');
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { agentId: 'agentBuilder', scope: 'agent_builder' },
          message: 'build a support agent',
        }),
      );
    });

    it('forwards context selections to the agent builder message', async () => {
      const action = createAction();
      const contextSelections = [
        {
          content: 'const selected = true;',
          filePath: 'src/example.ts',
          id: 'code-selection',
          lineRange: { endLine: 12, startLine: 10 },
          source: 'code' as const,
        },
      ];

      await action.sendAsAgent({ contextSelections, message: 'use this selected code' });

      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          contextSelections,
          message: 'use this selected code',
        }),
      );
    });

    it('passes the workspace slug to the agent builder message context', async () => {
      const action = createAction();

      await action.sendAsAgent({ message: 'build a support agent', workspaceSlug: 'team' });

      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { agentId: 'agentBuilder', scope: 'agent_builder', workspaceSlug: 'team' },
        }),
      );
    });

    it('seeds the agent builder with the inbox thinking effort before the first turn', async () => {
      agentState.agentConfigMap.inbox.chatConfig = {
        // A registry effort key for the inherited model family…
        gpt5_6ReasoningEffort: 'high',
        // …plus unrelated inbox settings that must NOT leak onto the builder row.
        enableHistoryCount: true,
        historyCount: 42,
        searchMode: 'auto',
      };

      const action = createAction();

      await action.sendAsAgent({ message: 'build a support agent' });

      expect(updateAgentConfigByIdMock).toHaveBeenCalledWith('agentBuilder', {
        chatConfig: { gpt5_6ReasoningEffort: 'high' },
        model: 'gpt-4o-mini',
        provider: 'openai',
      });

      // The builder's first LLM call must already see the level.
      expect(updateAgentConfigByIdMock.mock.invocationCallOrder[0]).toBeLessThan(
        sendMessageMock.mock.invocationCallOrder[0],
      );
    });

    it('clears a stale builder effort when the next inbox no longer sets one', async () => {
      // Run 1: inbox carries a level, so the builder row inherits it.
      agentState.agentConfigMap.inbox.chatConfig = { gpt5_6ReasoningEffort: 'high' };
      await createAction().sendAsAgent({ message: 'first assistant' });

      expect(agentState.agentConfigMap.agentBuilder.chatConfig).toEqual({
        gpt5_6ReasoningEffort: 'high',
      });

      // Run 2: a fresh inbox at its default must not launch on the builder's stale level.
      vi.clearAllMocks();
      agentState.agentConfigMap.inbox.chatConfig = {};
      await createAction().sendAsAgent({ message: 'second assistant' });

      expect(updateAgentConfigByIdMock).toHaveBeenCalledWith('agentBuilder', {
        // `merge()` skips undefined, so the clear has to be an explicit null.
        chatConfig: { gpt5_6ReasoningEffort: null },
        model: 'gpt-4o-mini',
        provider: 'openai',
      });
    });

    it('omits chatConfig when the inbox agent has no effort level set', async () => {
      agentState.agentConfigMap.inbox.chatConfig = { searchMode: 'auto' };

      const action = createAction();

      await action.sendAsAgent({ message: 'build a support agent' });

      expect(updateAgentConfigByIdMock).toHaveBeenCalledWith('agentBuilder', {
        model: 'gpt-4o-mini',
        provider: 'openai',
      });
    });
  });

  describe('sendAsGroup', () => {
    it('opens the existing group agent builder panel for prompt-based group creation', async () => {
      const action = createAction();

      await action.sendAsGroup({ message: 'build a research group' });

      expect(setChatPanelExpandedMock).toHaveBeenCalledWith(true);
      expect(navigateMock).toHaveBeenCalledWith('/group/group-new/profile');
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { agentId: 'groupAgentBuilder', scope: 'group_agent_builder' },
          message: 'build a research group',
        }),
      );
    });

    it('passes the workspace slug to the group builder message context', async () => {
      const action = createAction();

      await action.sendAsGroup({ message: 'build a research group', workspaceSlug: 'team' });

      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {
            agentId: 'groupAgentBuilder',
            scope: 'group_agent_builder',
            workspaceSlug: 'team',
          },
        }),
      );
    });

    it('seeds the group agent builder with the inbox thinking effort before the first turn', async () => {
      agentState.agentConfigMap.inbox.chatConfig = {
        searchMode: 'auto',
        thinkingLevel: 'low',
      };

      const action = createAction();

      await action.sendAsGroup({ message: 'build a research group' });

      expect(updateAgentConfigByIdMock).toHaveBeenCalledWith('groupAgentBuilder', {
        chatConfig: { thinkingLevel: 'low' },
        model: 'gpt-4o-mini',
        provider: 'openai',
      });

      expect(updateAgentConfigByIdMock.mock.invocationCallOrder[0]).toBeLessThan(
        sendMessageMock.mock.invocationCallOrder[0],
      );
    });

    it('clears a stale group builder effort when the next inbox no longer sets one', async () => {
      agentState.agentConfigMap.inbox.chatConfig = { thinkingLevel: 'low' };
      await createAction().sendAsGroup({ message: 'first group' });

      expect(agentState.agentConfigMap.groupAgentBuilder.chatConfig).toEqual({
        thinkingLevel: 'low',
      });

      vi.clearAllMocks();
      agentState.agentConfigMap.inbox.chatConfig = {};
      await createAction().sendAsGroup({ message: 'second group' });

      expect(updateAgentConfigByIdMock).toHaveBeenCalledWith('groupAgentBuilder', {
        chatConfig: { thinkingLevel: null },
        model: 'gpt-4o-mini',
        provider: 'openai',
      });
    });
  });

  describe('sendAsWrite', () => {
    it('passes the freshly created document id through the page context', async () => {
      const action = createAction();

      await action.sendAsWrite({ message: 'write me a doc' });

      expect(createDocumentMock).toHaveBeenCalled();
      expect(navigateMock).toHaveBeenCalledWith('/page/doc-new');
      // The new editor has not mounted yet, so the doc id must travel in context
      // explicitly rather than relying on the page editor runtime singleton.
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { agentId: 'pageAgent', documentId: 'doc-new', scope: 'page' },
          message: 'write me a doc',
        }),
      );
    });

    it('passes the workspace slug to the page agent message context', async () => {
      const action = createAction();

      await action.sendAsWrite({ message: 'write me a doc', workspaceSlug: 'team' });

      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {
            agentId: 'pageAgent',
            documentId: 'doc-new',
            scope: 'page',
            workspaceSlug: 'team',
          },
        }),
      );
    });
  });
});
