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
    useLocationMock.mockReturnValue({ pathname: '/agent/agent-1' });

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
    useParamsMock.mockReturnValue({ aid: 'agent-1' });
    useSearchParamsMock.mockReturnValue([new URLSearchParams(''), vi.fn()]);
    useLocationMock.mockReturnValue({ pathname: '/agent/agent-1' });
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
