import { INBOX_SESSION_ID } from '@lobechat/const';
import type { AgentItem } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOnlyFetchOnceSWR } from '@/libs/swr';
import { initialAgentSliceState } from '@/store/agent/slices/agent/initialState';

import { builtinAgentSelectors } from '../../selectors/builtinAgentSelectors';
import type { AgentStore } from '../../store';
import { BuiltinAgentSliceActionImpl } from './action';
import { initialBuiltinAgentSliceState } from './initialState';

vi.mock('@/libs/swr', () => ({
  useOnlyFetchOnceSWR: vi.fn(() => ({ data: undefined })),
}));

describe('BuiltinAgentSliceActionImpl.useInitBuiltinAgent', () => {
  let store: AgentStore;
  const get = () => store;
  const set = vi.fn(
    (update: Partial<AgentStore> | ((state: AgentStore) => Partial<AgentStore>)) => {
      const patch = typeof update === 'function' ? update(store) : update;
      store = { ...store, ...patch };
    },
  );

  const inboxAgent = (title: string): AgentItem => ({ id: 'inbox-agent', title }) as AgentItem;

  const succeed = (requestIndex: number, data: AgentItem | null): void => {
    const options = vi.mocked(useOnlyFetchOnceSWR).mock.calls[requestIndex][2] as {
      onSuccess: (value: AgentItem | null) => void;
    };
    options.onSuccess(data);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = {
      ...initialAgentSliceState,
      ...initialBuiltinAgentSliceState,
      internal_dispatchAgentMap: vi.fn((id, data) => {
        store = { ...store, agentMap: { ...store.agentMap, [id]: data } };
      }),
    } as unknown as AgentStore;
  });

  it('uses the stable user/workspace cache scope for inbox requests', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: true,
    });

    expect(useOnlyFetchOnceSWR).toHaveBeenCalledWith(
      ['builtinAgent:init', 'inbox', '12', 'user-a:workspace-a'],
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('changes the inbox request key when the active workspace changes at the same revision', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: true,
    });
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-b',
      isLogin: true,
    });

    expect(vi.mocked(useOnlyFetchOnceSWR).mock.calls[0][0]).toEqual([
      'builtinAgent:init',
      'inbox',
      '12',
      'user-a:workspace-a',
    ]);
    expect(vi.mocked(useOnlyFetchOnceSWR).mock.calls[1][0]).toEqual([
      'builtinAgent:init',
      'inbox',
      '12',
      'user-a:workspace-b',
    ]);
  });

  it('does not expose workspace A while workspace B is pending at the same revision', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.syncInboxProjectionScope('user-a:workspace-a', true);
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: true,
    });
    succeed(0, inboxAgent('Workspace A Assistant'));

    action.syncInboxProjectionScope('user-a:workspace-b', true);
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-b',
      isLogin: true,
    });

    expect(store.builtinAgentIdMap[INBOX_SESSION_ID]).toBeUndefined();
    expect(store.agentMap['inbox-agent']).toBeUndefined();
    expect(store.inboxProjectionScope).toBeUndefined();
    expect(
      builtinAgentSelectors.inboxAgentMetaForScope('user-a:workspace-b')(store),
    ).toBeUndefined();
  });

  it('atomically clears an active old Inbox without changing a non-Inbox active agent', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);
    store = {
      ...store,
      activeAgentId: 'inbox-agent',
      activeInboxScope: 'user-a:workspace-a',
      agentMap: { 'inbox-agent': inboxAgent('Workspace A Assistant') },
      builtinAgentIdMap: { [INBOX_SESSION_ID]: 'inbox-agent' },
      inboxProjectionScope: 'user-a:workspace-a',
    };

    action.syncInboxProjectionScope('user-a:workspace-b', true);

    expect(store).toMatchObject({
      activeAgentId: undefined,
      activeInboxScope: 'user-a:workspace-b',
      builtinAgentIdMap: {},
      inboxProjectionScope: undefined,
    });

    store = { ...store, activeAgentId: 'regular-agent' };
    action.syncInboxProjectionScope('user-a:workspace-c', true);

    expect(store.activeAgentId).toBe('regular-agent');
  });

  it('disables the inbox request after logout instead of reading the previous user key', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: false,
    });

    expect(useOnlyFetchOnceSWR).toHaveBeenCalledWith(
      null,
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('does not reuse a persisted user key across logout and the next login', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: true,
    });
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: false,
    });
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-b:workspace-a',
      isLogin: true,
    });

    expect(vi.mocked(useOnlyFetchOnceSWR).mock.calls.map(([key]) => key)).toEqual([
      ['builtinAgent:init', 'inbox', '12', 'user-a:workspace-a'],
      null,
      ['builtinAgent:init', 'inbox', '12', 'user-b:workspace-a'],
    ]);
  });

  it('does not expose user A through logout, unresolved persisted scope, anonymous, and user B', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.syncInboxProjectionScope('user-a:workspace-a', true);
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: true,
    });
    succeed(0, inboxAgent('User A Assistant'));

    action.syncInboxProjectionScope('user-a:workspace-a', false);
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: false,
    });

    expect(store.builtinAgentIdMap[INBOX_SESSION_ID]).toBeUndefined();
    expect(store.agentMap['inbox-agent']).toBeUndefined();
    for (const scope of [undefined, 'anon:personal', 'user-b:workspace-a']) {
      expect(builtinAgentSelectors.inboxAgentMetaForScope(scope)(store)).toBeUndefined();
    }

    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-b:workspace-a',
      isLogin: true,
    });

    expect(
      builtinAgentSelectors.inboxAgentMetaForScope('user-b:workspace-a')(store),
    ).toBeUndefined();
  });

  it('ignores an old workspace response that arrives after the new workspace response', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.syncInboxProjectionScope('user-a:workspace-a', true);
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: true,
    });
    action.syncInboxProjectionScope('user-a:workspace-b', true);
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-b',
      isLogin: true,
    });

    succeed(1, inboxAgent('Workspace B Assistant'));
    succeed(0, inboxAgent('Workspace A Assistant'));

    expect(store.inboxProjectionScope).toBe('user-a:workspace-b');
    expect(builtinAgentSelectors.inboxAgentMetaForScope('user-a:workspace-b')(store)).toMatchObject(
      { title: 'Workspace B Assistant' },
    );
  });

  it('ignores a persisted-scope response that arrives after logout', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.syncInboxProjectionScope('user-a:workspace-a', true);
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: true,
    });
    action.syncInboxProjectionScope('user-a:workspace-a', false);
    action.useInitBuiltinAgent(INBOX_SESSION_ID, {
      brandingRevision: '12',
      cacheScope: 'user-a:workspace-a',
      isLogin: false,
    });
    succeed(0, inboxAgent('User A Assistant'));

    expect(store.inboxProjectionScope).toBeUndefined();
    expect(store.builtinAgentIdMap[INBOX_SESSION_ID]).toBeUndefined();
  });

  it('keeps the existing non-inbox key regardless of cache scope', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent('page-agent', { brandingRevision: '12', isLogin: true });

    expect(useOnlyFetchOnceSWR).toHaveBeenCalledWith(
      ['builtinAgent:init', 'page-agent'],
      expect.any(Function),
      expect.any(Object),
    );

    succeed(0, { id: 'page-agent-id', title: 'Page Agent' } as unknown as AgentItem);

    expect(store.builtinAgentIdMap['page-agent']).toBe('page-agent-id');
    expect(store.inboxProjectionScope).toBeUndefined();
  });
});
