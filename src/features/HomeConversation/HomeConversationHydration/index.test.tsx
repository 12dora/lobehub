/**
 * @vitest-environment happy-dom
 */
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '@/store/agent/store';
import { useAgentGroupStore } from '@/store/agentGroup/store';
import { useChatStore } from '@/store/chat/store';

import HomeConversationHydration from './index';

const navigateMock = vi.hoisted(() => vi.fn());
const setSearchParamsMock = vi.hoisted(() => vi.fn());
const useLocationMock = vi.hoisted(() => vi.fn());
const useSearchParamsMock = vi.hoisted(() => vi.fn());
const workspace = vi.hoisted(() => ({ slug: null as string | null }));

vi.mock('react-router', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = (await vi.importActual('react-router')) as typeof import('react-router');

  return {
    ...actual,
    useLocation: useLocationMock,
    useNavigate: () => navigateMock,
    useSearchParams: useSearchParamsMock,
  };
});

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => workspace.slug,
}));

vi.mock('@/features/Conversation/hooks', () => ({
  useClearActiveTopicUnread: () => {},
}));

const atHome = (search: string, pathname = '/') => {
  useLocationMock.mockReturnValue({ hash: '', pathname, search: search ? `?${search}` : '' });
  useSearchParamsMock.mockReturnValue([new URLSearchParams(search), setSearchParamsMock]);
};

describe('HomeConversationHydration', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    setSearchParamsMock.mockReset();
    useLocationMock.mockReset();
    useSearchParamsMock.mockReset();
    workspace.slug = null;

    useAgentStore.setState({ activeAgentId: undefined }, false);
    useAgentGroupStore.setState({ activeGroupId: undefined, router: undefined }, false);
    useChatStore.setState(
      { activeAgentId: undefined, activeGroupId: undefined, activeTopicId: undefined },
      false,
    );
  });

  it('hydrates the agent conversation from the search params', async () => {
    atHome('agent=agt_1&topic=tpc_1');

    render(<HomeConversationHydration />);

    await waitFor(() => {
      expect(useAgentStore.getState().activeAgentId).toBe('agt_1');
      expect(useChatStore.getState().activeAgentId).toBe('agt_1');
      expect(useChatStore.getState().activeTopicId).toBe('tpc_1');
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('hydrates the group conversation and injects a home-context router', async () => {
    atHome('group=grp_1&topic=tpc_1');

    render(<HomeConversationHydration />);

    await waitFor(() => {
      expect(useAgentGroupStore.getState().activeGroupId).toBe('grp_1');
      expect(useChatStore.getState().activeGroupId).toBe('grp_1');
      expect(useChatStore.getState().activeTopicId).toBe('tpc_1');
    });

    // The group store navigates through this router on `switchTopic`; it must
    // never be allowed to push `/group/...` (that swaps the left nav).
    act(() => {
      useAgentGroupStore.getState().router?.push('/group/grp_1/tpc_2', { replace: true });
    });

    expect(navigateMock).toHaveBeenCalledWith('/?group=grp_1&topic=tpc_2', { replace: true });
  });

  it('rewrites only the topic search param when the store switches topic', async () => {
    atHome('agent=agt_1&topic=tpc_1');

    render(<HomeConversationHydration />);
    await waitFor(() => expect(useChatStore.getState().activeTopicId).toBe('tpc_1'));
    navigateMock.mockClear();

    await act(async () => {
      useChatStore.setState({ activeTopicId: 'tpc_2' }, false);
    });

    expect(navigateMock).toHaveBeenCalledWith('/?agent=agt_1&topic=tpc_2', { replace: true });
    // Never the canonical chat path — that is what swaps the left nav.
    expect(navigateMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/agent/agt_1'),
      expect.anything(),
    );
  });

  it('drops the topic param (keeping the conversation) when the topic is cleared', async () => {
    atHome('agent=agt_1&topic=tpc_1');

    render(<HomeConversationHydration />);
    await waitFor(() => expect(useChatStore.getState().activeTopicId).toBe('tpc_1'));
    navigateMock.mockClear();

    await act(async () => {
      useChatStore.setState({ activeTopicId: null as unknown as undefined }, false);
    });

    expect(navigateMock).toHaveBeenCalledWith('/?agent=agt_1', { replace: true });
  });

  it('keeps the workspace pathname when rewriting the topic param', async () => {
    workspace.slug = 'acme';
    atHome('agent=agt_1&topic=tpc_1', '/acme');

    render(<HomeConversationHydration />);
    await waitFor(() => expect(useChatStore.getState().activeTopicId).toBe('tpc_1'));
    navigateMock.mockClear();

    await act(async () => {
      useChatStore.setState({ activeTopicId: 'tpc_2' }, false);
    });

    expect(navigateMock).toHaveBeenCalledWith('/acme?agent=agt_1&topic=tpc_2', { replace: true });
  });

  it('writes thread switches to the URL synchronously, leaving no pending timer', async () => {
    atHome('agent=agt_1&topic=tpc_1');

    const { unmount } = render(<HomeConversationHydration />);
    await waitFor(() => expect(useChatStore.getState().activeTopicId).toBe('tpc_1'));
    setSearchParamsMock.mockClear();

    vi.useFakeTimers();
    try {
      // Two switches inside one throttle window. A throttled binding would defer
      // the second into a trailing timer, and `useQueryParam` only cancels that
      // timer from a *passive* cleanup — which runs after this component's
      // *layout* cleanup has already unsubscribed. The deferred write would then
      // land on whatever route the user navigated to.
      act(() => {
        useChatStore.setState({ activeThreadId: 'thd_1' }, false);
      });
      act(() => {
        useChatStore.setState({ activeThreadId: 'thd_2' }, false);
      });

      // Both writes must already have happened, while still mounted, with
      // nothing left queued. These two assertions are the real guard: RTL's
      // `unmount()` flushes passive effects synchronously, so `useQueryParam`'s
      // own timer cleanup always wins *in a test* — the hazard only exists in a
      // real navigation commit. Pinning "no timer was ever scheduled" is what
      // actually fails if throttling comes back.
      expect(setSearchParamsMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);

      setSearchParamsMock.mockClear();
      unmount();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // Nothing may touch the query string after the hydrator is gone — not on
      // unmount, and not from a timer that outlived it.
      expect(setSearchParamsMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing off the home pathname', () => {
    useLocationMock.mockReturnValue({
      hash: '',
      pathname: '/agent/agt_1/tpc_1',
      search: '?agent=agt_1&topic=tpc_1',
    });
    useSearchParamsMock.mockReturnValue([
      new URLSearchParams('agent=agt_1&topic=tpc_1'),
      setSearchParamsMock,
    ]);

    render(<HomeConversationHydration />);

    expect(useAgentStore.getState().activeAgentId).toBeUndefined();
    expect(useChatStore.getState().activeTopicId).toBeUndefined();
  });

  it('releases the ids it owns on unmount, without stomping a re-routed agent', async () => {
    atHome('agent=agt_1&topic=tpc_1');

    const { unmount, rerender } = render(<HomeConversationHydration />);
    await waitFor(() => expect(useAgentStore.getState().activeAgentId).toBe('agt_1'));

    // Somebody else (the agent route's AgentIdSync) claimed the store first.
    act(() => {
      useAgentStore.setState({ activeAgentId: 'agt_routed' }, false);
    });
    rerender(<HomeConversationHydration />);
    unmount();

    expect(useAgentStore.getState().activeAgentId).toBe('agt_routed');
  });

  it('clears the agent it owns on unmount', async () => {
    atHome('agent=agt_1&topic=tpc_1');

    const { unmount } = render(<HomeConversationHydration />);
    await waitFor(() => expect(useAgentStore.getState().activeAgentId).toBe('agt_1'));

    unmount();

    expect(useAgentStore.getState().activeAgentId).toBeUndefined();
    expect(useChatStore.getState().activeAgentId).toBeUndefined();
    expect(useChatStore.getState().activeTopicId).toBeUndefined();
  });
});
