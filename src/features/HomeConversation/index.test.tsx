/**
 * Full-surface integration test for the home right column.
 *
 * The unit test next to `HomeConversationHydration` only proves the hydrator in
 * isolation. What actually broke the feature was a *second*, hidden hydrator
 * inside the reused conversation tree, which only appears once the lazy surface
 * resolves — so this suite renders `HomeConversation` end to end (through
 * `React.lazy`) and asserts the selected topic and the URL both survive.
 *
 * @vitest-environment happy-dom
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '@/store/agent/store';
import { useAgentGroupStore } from '@/store/agentGroup/store';
import { useChatStore } from '@/store/chat/store';

import HomeConversation from './index';

const navigateMock = vi.hoisted(() => vi.fn());
const setSearchParamsMock = vi.hoisted(() => vi.fn());
const useLocationMock = vi.hoisted(() => vi.fn());
const useSearchParamsMock = vi.hoisted(() => vi.fn());
const fetchChatTopicsMock = vi.hoisted(() => vi.fn());

vi.mock('react-router', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = (await vi.importActual('react-router')) as typeof import('react-router');

  return {
    ...actual,
    useLocation: useLocationMock,
    useNavigate: () => navigateMock,
    useParams: () => ({}),
    useSearchParams: useSearchParamsMock,
  };
});

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => null,
}));

vi.mock('@/features/Conversation/hooks', () => ({
  useClearActiveTopicUnread: () => {},
}));

vi.mock('@/hooks/useFetchChatTopics', () => ({
  useFetchChatTopics: (...args: unknown[]) => {
    fetchChatTopicsMock(...args);
    return { isRevalidating: false };
  },
}));

vi.mock('@/hooks/useInitAgentConfig', () => ({ useInitAgentConfig: () => ({ isLoading: false }) }));
vi.mock('@/hooks/useInitGroupConfig', () => ({ useInitGroupConfig: () => ({ isLoading: false }) }));

// The conversation trees themselves are enormous and orthogonal to what this
// suite proves; what matters is that the surfaces resolve and that the *route*
// hydration inside them stays disabled.
vi.mock('@/routes/(main)/agent/features/Conversation', () => ({
  default: () => <div data-testid="agent-conversation" />,
}));
vi.mock('@/routes/(main)/agent/features/Conversation/Header', () => ({ default: () => null }));
vi.mock('@/routes/(main)/agent/features/Conversation/WorkingSidebar', () => ({
  default: () => null,
}));
vi.mock('@/routes/(main)/agent/features/Portal', () => ({ default: () => null }));

vi.mock('@/routes/(main)/group/features/Conversation/Header', () => ({ default: () => null }));
vi.mock('@/routes/(main)/group/features/Portal', () => ({ default: () => null }));
vi.mock('@/components/DragUploadZone', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUploadFiles: () => ({ handleUploadFiles: vi.fn() }),
}));

/**
 * The real group `ConversationArea`, with only its heavy chat internals stubbed:
 * the `disableRouteHydration` branch and the route `ChatHydration` it guards are
 * the actual subject here, so neither is mocked away.
 */
vi.mock('@/features/Conversation', () => ({
  ChatList: () => <div data-testid="group-chat-list" />,
  ConversationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/features/Conversation/MessageForward', () => ({
  ForwardMessageDispatcher: () => null,
  MessageForwardFooter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/features/ChatMiniMap', () => ({ default: () => null }));
vi.mock('@/routes/(main)/group/features/Conversation/AgentWelcome', () => ({
  default: () => null,
}));
vi.mock('@/routes/(main)/group/features/Conversation/MainChatInput', () => ({
  default: () => null,
}));
vi.mock('@/routes/(main)/group/features/Conversation/MainChatInput/MessageFromUrl', () => ({
  default: () => null,
}));
vi.mock('@/routes/(main)/group/features/Conversation/ThreadHydration', () => ({
  default: () => null,
}));
vi.mock('@/routes/(main)/group/features/Conversation/useActionsBarConfig', () => ({
  useActionsBarConfig: () => ({}),
}));
vi.mock('@/hooks/useOperationState', () => ({ useOperationState: () => ({}) }));

const atHome = (search: string) => {
  useLocationMock.mockReturnValue({ hash: '', pathname: '/', search: `?${search}` });
  useSearchParamsMock.mockReturnValue([new URLSearchParams(search), setSearchParamsMock]);
};

describe('HomeConversation (full surface)', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    setSearchParamsMock.mockReset();
    useLocationMock.mockReset();
    useSearchParamsMock.mockReset();
    fetchChatTopicsMock.mockReset();

    useAgentStore.setState({ activeAgentId: undefined }, false);
    useAgentGroupStore.setState({ activeGroupId: undefined, router: undefined }, false);
    useChatStore.setState(
      {
        activeAgentId: undefined,
        activeGroupId: undefined,
        activeThreadId: undefined,
        activeTopicId: undefined,
      },
      false,
    );
  });

  it('keeps the group topic selected after the lazy surface resolves', async () => {
    atHome('group=grp_1&topic=tpc_1');

    render(<HomeConversation groupId="grp_1" topicId="tpc_1" />);

    // Wait for React.lazy to resolve — the regression only appeared at this point,
    // because the group ConversationArea's own ChatHydration mounts with it.
    await screen.findByTestId('group-chat-list');

    expect(useChatStore.getState().activeTopicId).toBe('tpc_1');
    expect(useAgentGroupStore.getState().activeGroupId).toBe('grp_1');
  });

  it('never rewrites the group URL away from the selected topic', async () => {
    atHome('group=grp_1&topic=tpc_1');

    render(<HomeConversation groupId="grp_1" topicId="tpc_1" />);
    await screen.findByTestId('group-chat-list');

    // Give the route hydrator's layout effects a chance to misfire.
    await waitFor(() => expect(useChatStore.getState().activeTopicId).toBe('tpc_1'));

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('fetches the topic list for the group surface', async () => {
    atHome('group=grp_1&topic=tpc_1');

    render(<HomeConversation groupId="grp_1" topicId="tpc_1" />);
    await screen.findByTestId('group-chat-list');

    expect(fetchChatTopicsMock).toHaveBeenCalled();
  });

  it('hydrates and fetches topics for the agent surface', async () => {
    atHome('agent=agt_1&topic=tpc_1');

    render(<HomeConversation agentId="agt_1" topicId="tpc_1" />);
    await screen.findByTestId('agent-conversation');

    expect(useAgentStore.getState().activeAgentId).toBe('agt_1');
    expect(useChatStore.getState().activeTopicId).toBe('tpc_1');
    expect(fetchChatTopicsMock).toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('hydrates the thread from ?thread= instead of leaving a stale one', async () => {
    useChatStore.setState({ activeThreadId: 'thd_stale' }, false);
    atHome('agent=agt_1&topic=tpc_1&thread=thd_1');

    render(<HomeConversation agentId="agt_1" topicId="tpc_1" />);
    await screen.findByTestId('agent-conversation');

    expect(useChatStore.getState().activeThreadId).toBe('thd_1');
  });

  it('clears a stale thread when the URL carries none', async () => {
    useChatStore.setState({ activeThreadId: 'thd_stale' }, false);
    atHome('agent=agt_1&topic=tpc_1');

    render(<HomeConversation agentId="agt_1" topicId="tpc_1" />);
    await screen.findByTestId('agent-conversation');

    expect(useChatStore.getState().activeThreadId).toBeNull();
  });
});
