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
