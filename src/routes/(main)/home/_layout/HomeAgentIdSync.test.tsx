/**
 * @vitest-environment happy-dom
 */
import { INBOX_SESSION_ID } from '@lobechat/const';
import { act, render } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialState as initialAgentState } from '@/store/agent/initialState';
import { useAgentStore } from '@/store/agent/store';

import HomeAgentIdSync from './HomeAgentIdSync';

let currentScope = 'user-a:workspace-a';

const route = vi.hoisted(() => ({ pathname: '/', search: '', slug: null as string | null }));

vi.mock('react-router', () => ({
  useLocation: () => ({ pathname: route.pathname }),
  useSearchParams: () => [new URLSearchParams(route.search), vi.fn()],
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => route.slug,
}));

vi.mock('@/libs/swr/useCacheScope', () => ({
  useCacheScope: () => currentScope,
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: { isSignedIn: boolean }) => unknown) =>
    selector({ isSignedIn: true }),
}));

const ScopeHarness = ({ scope }: { scope: string }) => {
  currentScope = scope;
  const syncInboxProjectionScope = useAgentStore((state) => state.syncInboxProjectionScope);

  useLayoutEffect(() => {
    syncInboxProjectionScope(scope, true);
  }, [scope, syncInboxProjectionScope]);

  return <HomeAgentIdSync />;
};

describe('HomeAgentIdSync', () => {
  beforeEach(() => {
    route.pathname = '/';
    route.search = '';
    route.slug = null;
    currentScope = 'user-a:workspace-a';
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
  });

  it('clears workspace A before B resolves, then activates B', () => {
    const { rerender } = render(<ScopeHarness scope="user-a:workspace-a" />);

    expect(useAgentStore.getState().activeAgentId).toBe('inbox-agent-a');

    rerender(<ScopeHarness scope="user-a:workspace-b" />);

    expect(useAgentStore.getState()).toMatchObject({
      activeAgentId: undefined,
      activeInboxScope: 'user-a:workspace-b',
      builtinAgentIdMap: {},
      inboxProjectionScope: undefined,
    });
    expect(useAgentStore.getState().agentMap['inbox-agent-a']).toBeUndefined();

    act(() => {
      useAgentStore.setState({
        agentMap: { 'inbox-agent-b': { id: 'inbox-agent-b', title: 'Workspace B' } },
        builtinAgentIdMap: { [INBOX_SESSION_ID]: 'inbox-agent-b' },
        inboxProjectionScope: 'user-a:workspace-b',
      });
    });

    expect(useAgentStore.getState().activeAgentId).toBe('inbox-agent-b');
  });

  it('does not clear a true non-Inbox active agent during scope invalidation', () => {
    useAgentStore.setState({ activeAgentId: 'regular-agent' });
    const { rerender } = render(<ScopeHarness scope="user-a:workspace-a" />);

    // Home owns the active route while its scoped Inbox exists.
    expect(useAgentStore.getState().activeAgentId).toBe('inbox-agent-a');

    act(() => useAgentStore.setState({ activeAgentId: 'regular-agent' }));
    rerender(<ScopeHarness scope="user-a:workspace-b" />);

    expect(useAgentStore.getState().activeAgentId).toBe('regular-agent');
  });
});

describe('HomeAgentIdSync route + conversation gates', () => {
  beforeEach(() => {
    route.pathname = '/';
    route.search = '';
    route.slug = null;
    currentScope = 'user-a:workspace-a';
    useAgentStore.setState(
      {
        ...initialAgentState,
        activeAgentId: undefined,
        activeInboxScope: currentScope,
        agentMap: { 'inbox-agent-a': { id: 'inbox-agent-a', title: 'Workspace A' } },
        builtinAgentIdMap: { [INBOX_SESSION_ID]: 'inbox-agent-a' },
        inboxProjectionScope: currentScope,
      },
      false,
    );
  });

  it('syncs the inbox on the bare home route', () => {
    render(<ScopeHarness scope="user-a:workspace-a" />);

    expect(useAgentStore.getState().activeAgentId).toBe('inbox-agent-a');
  });

  it('syncs the inbox on the workspace home route', () => {
    route.pathname = '/acme';
    route.slug = 'acme';

    render(<ScopeHarness scope="user-a:workspace-a" />);

    expect(useAgentStore.getState().activeAgentId).toBe('inbox-agent-a');
  });

  it('does not force the inbox while a home conversation is open', () => {
    route.search = 'agent=agt_conversation&topic=tpc_1';
    useAgentStore.setState({ activeAgentId: 'agt_conversation' });

    render(<ScopeHarness scope="user-a:workspace-a" />);

    expect(useAgentStore.getState().activeAgentId).toBe('agt_conversation');
  });

  it('does not force the inbox while a home group conversation is open', () => {
    route.search = 'group=grp_1&topic=tpc_1';

    render(<ScopeHarness scope="user-a:workspace-a" />);

    expect(useAgentStore.getState().activeAgentId).toBeUndefined();
  });

  it('releases the inbox id in the navigation commit, not when Activity hides', () => {
    const { rerender } = render(<ScopeHarness scope="user-a:workspace-a" />);
    expect(useAgentStore.getState().activeAgentId).toBe('inbox-agent-a');

    // Same commit as the route change — the component (still mounted inside the
    // home <Activity>) must render null right away so its cleanup runs now.
    route.pathname = '/agent/agt_routed';
    rerender(<ScopeHarness scope="user-a:workspace-a" />);

    expect(useAgentStore.getState().activeAgentId).toBeUndefined();
  });

  it('never overwrites an agent the route already claimed', () => {
    const { rerender } = render(<ScopeHarness scope="user-a:workspace-a" />);

    act(() => {
      useAgentStore.setState({ activeAgentId: 'agt_routed' });
    });

    route.pathname = '/agent/agt_routed';
    rerender(<ScopeHarness scope="user-a:workspace-a" />);

    expect(useAgentStore.getState().activeAgentId).toBe('agt_routed');
  });
});
