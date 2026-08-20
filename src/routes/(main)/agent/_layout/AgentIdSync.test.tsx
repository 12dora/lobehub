/**
 * @vitest-environment happy-dom
 */
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '@/store/agent';
import { initialState as initialChatState } from '@/store/chat/initialState';
import { PortalViewType } from '@/store/chat/slices/portal/initialState';
import { useChatStore } from '@/store/chat/store';

import AgentIdSync from './AgentIdSync';

const workspaceSlug = vi.hoisted(() => ({ current: null as string | null }));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => workspaceSlug.current,
}));

const useParamsMock = vi.hoisted(() => vi.fn());
const useSearchParamsMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());
const useLocationMock = vi.hoisted(() => vi.fn());

vi.mock('react-router', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = (await vi.importActual('react-router')) as typeof import('react-router');

  return {
    ...actual,
    useLocation: useLocationMock,
    useNavigate: () => useNavigateMock,
    useParams: useParamsMock,
    useSearchParams: useSearchParamsMock,
  };
});

describe('AgentIdSync', () => {
  beforeEach(() => {
    useParamsMock.mockReset();
    useSearchParamsMock.mockReset();
    useNavigateMock.mockReset();
    useLocationMock.mockReset();
    useLocationMock.mockReturnValue({ hash: '', pathname: '/agent/agent-1' });
    workspaceSlug.current = null;

    useChatStore.setState(
      {
        ...initialChatState,
        activeAgentId: 'agent-1',
        activeTopicId: 'topic-1',
        portalStack: [{ type: PortalViewType.Home }],
        showPortal: true,
      },
      false,
    );

    useAgentStore.setState({ activeAgentId: undefined, builtinAgentIdMap: {} }, false);
  });

  it('clears portal state when switching to another agent without a topic in the URL', () => {
    useParamsMock.mockReturnValue({ aid: 'agent-1' });
    useSearchParamsMock.mockReturnValue([new URLSearchParams(''), vi.fn()]);

    const { rerender } = render(<AgentIdSync />);

    expect(useChatStore.getState().showPortal).toBe(true);

    useParamsMock.mockReturnValue({ aid: 'agent-2' });
    useLocationMock.mockReturnValue({ pathname: '/agent/agent-2' });
    rerender(<AgentIdSync />);

    expect(useChatStore.getState().activeTopicId).toBeNull();
    expect(useChatStore.getState().portalStack).toEqual([]);
    expect(useChatStore.getState().showPortal).toBe(false);
  });

  it('still clears portal state when the destination URL already has a topic', () => {
    useParamsMock.mockReturnValue({ aid: 'agent-1' });
    useSearchParamsMock.mockReturnValue([new URLSearchParams('topic=topic-2'), vi.fn()]);

    const { rerender } = render(<AgentIdSync />);

    useParamsMock.mockReturnValue({ aid: 'agent-2' });
    useLocationMock.mockReturnValue({ pathname: '/agent/agent-2' });
    rerender(<AgentIdSync />);

    expect(useChatStore.getState().portalStack).toEqual([]);
    expect(useChatStore.getState().showPortal).toBe(false);
    expect(useChatStore.getState().activeTopicId).toBe('topic-1');
  });

  it('preserves the active topic when the destination route carries a topic path segment', () => {
    useParamsMock.mockReturnValue({ aid: 'agent-1', topicId: 'topic-1' });
    useSearchParamsMock.mockReturnValue([new URLSearchParams(''), vi.fn()]);

    const { rerender } = render(<AgentIdSync />);

    useParamsMock.mockReturnValue({ aid: 'agent-2', topicId: 'topic-2' });
    rerender(<AgentIdSync />);

    expect(useChatStore.getState().portalStack).toEqual([]);
    expect(useChatStore.getState().showPortal).toBe(false);
    expect(useChatStore.getState().activeTopicId).toBe('topic-1');
  });
});

describe('AgentIdSync activeAgentId ownership', () => {
  beforeEach(() => {
    useNavigateMock.mockReset();
    workspaceSlug.current = null;
    useParamsMock.mockReturnValue({ aid: 'agent-1' });
    useSearchParamsMock.mockReturnValue([new URLSearchParams(''), vi.fn()]);
    useLocationMock.mockReturnValue({ hash: '', pathname: '/agent/agent-1' });
    useAgentStore.setState({ activeAgentId: undefined, builtinAgentIdMap: {} }, false);
  });

  it('adopts the routed id on mount', () => {
    render(<AgentIdSync />);

    expect(useAgentStore.getState().activeAgentId).toBe('agent-1');
  });

  it('restores the routed id when another tree clears it after the navigation commit', () => {
    render(<AgentIdSync />);

    // e.g. the home layout's delayed <Activity> teardown, ~180ms later
    act(() => {
      useAgentStore.setState({ activeAgentId: undefined }, false);
    });

    expect(useAgentStore.getState().activeAgentId).toBe('agent-1');
  });

  it('restores the routed id when another tree overwrites it with a different agent', () => {
    render(<AgentIdSync />);

    act(() => {
      useAgentStore.setState({ activeAgentId: 'inbox-agent' }, false);
    });

    expect(useAgentStore.getState().activeAgentId).toBe('agent-1');
  });

  it('does not pin an unresolved builtin slug into the store', () => {
    useParamsMock.mockReturnValue({ aid: 'inbox' });
    useLocationMock.mockReturnValue({ pathname: '/agent/inbox' });

    render(<AgentIdSync />);

    act(() => {
      useAgentStore.setState({ activeAgentId: 'real-inbox-id' }, false);
    });

    expect(useAgentStore.getState().activeAgentId).toBe('real-inbox-id');
  });

  it('still clears the id on unmount (the restore guard must not resurrect it)', () => {
    const { unmount } = render(<AgentIdSync />);

    expect(useAgentStore.getState().activeAgentId).toBe('agent-1');

    unmount();

    expect(useAgentStore.getState().activeAgentId).toBeUndefined();
  });
});

describe('AgentIdSync builtin slug redirect', () => {
  const INBOX_ID = 'inbox-agent-id';

  const renderAt = (pathname: string, search = '', hash = '') => {
    useParamsMock.mockReturnValue({ aid: 'inbox' });
    useSearchParamsMock.mockReturnValue([new URLSearchParams(search), vi.fn()]);
    useLocationMock.mockReturnValue({ hash, pathname });

    return render(<AgentIdSync />);
  };

  beforeEach(() => {
    useNavigateMock.mockReset();
    workspaceSlug.current = null;
    useAgentStore.setState(
      { activeAgentId: undefined, builtinAgentIdMap: { inbox: INBOX_ID } },
      false,
    );
  });

  it('rewrites only the agent id segment on an unprefixed URL', () => {
    renderAt('/agent/inbox');

    expect(useNavigateMock).toHaveBeenCalledWith(`/agent/${INBOX_ID}`, { replace: true });
  });

  it('keeps a workspace prefix instead of appending the slug as a topic id', () => {
    workspaceSlug.current = 'acme';

    renderAt('/acme/agent/inbox');

    expect(useNavigateMock).toHaveBeenCalledWith(`/acme/agent/${INBOX_ID}`, { replace: true });
    // regression: the old `pathname.replace('/agent/inbox', '')` treated the
    // workspace prefix as a suffix and re-prefixed it, duplicating the slug
    expect(useNavigateMock).not.toHaveBeenCalledWith(`/acme/agent/${INBOX_ID}/acme`, {
      replace: true,
    });
  });

  it('preserves a workspace prefix even before the active slug hydrates', () => {
    workspaceSlug.current = null;

    renderAt('/acme/agent/inbox');

    expect(useNavigateMock).toHaveBeenCalledWith(`/acme/agent/${INBOX_ID}`, { replace: true });
  });

  it('preserves a topic child path under a workspace prefix', () => {
    workspaceSlug.current = 'acme';

    renderAt('/acme/agent/inbox/topic-9');

    expect(useNavigateMock).toHaveBeenCalledWith(`/acme/agent/${INBOX_ID}/topic-9`, {
      replace: true,
    });
  });

  it('preserves a sub-route child path under a workspace prefix', () => {
    workspaceSlug.current = 'acme';

    renderAt('/acme/agent/inbox/profile');

    expect(useNavigateMock).toHaveBeenCalledWith(`/acme/agent/${INBOX_ID}/profile`, {
      replace: true,
    });
  });

  it('preserves the debug-proxy prefix and its child path', () => {
    renderAt('/_dangerous_local_dev_proxy/agent/inbox/profile');

    expect(useNavigateMock).toHaveBeenCalledWith(
      `/_dangerous_local_dev_proxy/agent/${INBOX_ID}/profile`,
      { replace: true },
    );
  });

  it('preserves the query string alongside a workspace prefix', () => {
    workspaceSlug.current = 'acme';

    renderAt('/acme/agent/inbox', 'topic=topic-9');

    expect(useNavigateMock).toHaveBeenCalledWith(`/acme/agent/${INBOX_ID}?topic=topic-9`, {
      replace: true,
    });
  });

  it('preserves the hash', () => {
    renderAt('/agent/inbox', '', '#section');

    expect(useNavigateMock).toHaveBeenCalledWith(`/agent/${INBOX_ID}#section`, { replace: true });
  });

  it('does not redirect while the builtin slug is unresolved', () => {
    useAgentStore.setState({ builtinAgentIdMap: {} }, false);

    renderAt('/acme/agent/inbox');

    expect(useNavigateMock).not.toHaveBeenCalled();
  });
});
