/**
 * @vitest-environment happy-dom
 */
import { INBOX_SESSION_ID } from '@lobechat/const';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialState as initialAgentState } from '@/store/agent/initialState';
import { useAgentStore } from '@/store/agent/store';
import { initialState as initialChatState } from '@/store/chat/initialState';
import { useChatStore } from '@/store/chat/store';

import PopupAgentQuickPage from './index';

const useFetchTopicsMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());
let currentScope = 'user-a:workspace-a';

vi.mock('react-router', () => ({ useParams: useParamsMock }));
vi.mock('@/libs/swr/useCacheScope', () => ({ useCacheScope: () => currentScope }));
vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: { isSignedIn: boolean }) => unknown) =>
    selector({ isSignedIn: true }),
}));
vi.mock('@/hooks/useFetchTopics', () => ({ useFetchTopics: useFetchTopicsMock }));
vi.mock('@/hooks/useInitAgentConfig', () => ({ useInitAgentConfig: vi.fn() }));
vi.mock('@/components/Loading/BrandTextLoading', () => ({ default: () => <div>loading</div> }));
vi.mock('@/features/AgentHome/WelcomeExtraContext', () => ({
  WelcomeExtraProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/routes/(main)/agent/features/Conversation', () => ({
  default: () => <div>conversation</div>,
}));
vi.mock('./QuickChatAgentSwitcher', () => ({ default: () => null }));

describe('PopupAgentQuickPage Inbox scope', () => {
  beforeEach(() => {
    currentScope = 'user-a:workspace-a';
    useParamsMock.mockReturnValue({ aid: INBOX_SESSION_ID });
    useFetchTopicsMock.mockReset();
    useAgentStore.setState(
      {
        ...initialAgentState,
        activeAgentId: 'inbox-agent-a',
        activeInboxScope: currentScope,
        agentMap: { 'inbox-agent-a': { id: 'inbox-agent-a', title: 'Workspace A' } },
        builtinAgentIdMap: { [INBOX_SESSION_ID]: 'inbox-agent-a' },
        inboxProjectionScope: currentScope,
      },
      false,
    );
    useChatStore.setState(
      {
        ...initialChatState,
        activeAgentId: 'inbox-agent-a',
        activeTopicId: 'topic-a',
      },
      false,
    );
  });

  it('clears A while B is pending, never fetches topics with A, then activates B', () => {
    const { rerender } = render(<PopupAgentQuickPage />);

    expect(useFetchTopicsMock).toHaveBeenLastCalledWith({
      enabled: true,
      session: { agentId: 'inbox-agent-a', isInbox: true },
    });

    currentScope = 'user-a:workspace-b';
    act(() => {
      useAgentStore.getState().syncInboxProjectionScope(currentScope, true);
    });
    rerender(<PopupAgentQuickPage />);

    expect(useAgentStore.getState().builtinAgentIdMap[INBOX_SESSION_ID]).toBeUndefined();
    expect(useAgentStore.getState().activeAgentId).toBeUndefined();
    expect(useChatStore.getState().activeAgentId).toBeUndefined();
    expect(useFetchTopicsMock).toHaveBeenLastCalledWith({
      enabled: false,
      session: { agentId: undefined, isInbox: true },
    });

    act(() => {
      useAgentStore.setState({
        agentMap: { 'inbox-agent-b': { id: 'inbox-agent-b', title: 'Workspace B' } },
        builtinAgentIdMap: { [INBOX_SESSION_ID]: 'inbox-agent-b' },
        inboxProjectionScope: currentScope,
      });
    });

    expect(useAgentStore.getState().activeAgentId).toBe('inbox-agent-b');
    expect(useChatStore.getState().activeAgentId).toBe('inbox-agent-b');
    expect(useFetchTopicsMock).toHaveBeenLastCalledWith({
      enabled: true,
      session: { agentId: 'inbox-agent-b', isInbox: true },
    });
  });

  it('keeps a non-Inbox route active across Inbox scope invalidation', () => {
    useParamsMock.mockReturnValue({ aid: 'regular-agent' });
    const { rerender } = render(<PopupAgentQuickPage />);

    expect(useAgentStore.getState().activeAgentId).toBe('regular-agent');
    expect(useChatStore.getState().activeAgentId).toBe('regular-agent');

    currentScope = 'user-a:workspace-b';
    act(() => {
      useAgentStore.getState().syncInboxProjectionScope(currentScope, true);
    });
    rerender(<PopupAgentQuickPage />);

    expect(useAgentStore.getState().activeAgentId).toBe('regular-agent');
    expect(useChatStore.getState().activeAgentId).toBe('regular-agent');
    expect(useFetchTopicsMock).toHaveBeenLastCalledWith({
      enabled: true,
      session: { agentId: 'regular-agent', isInbox: false },
    });
  });
});
