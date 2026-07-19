import { INBOX_SESSION_ID } from '@lobechat/const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOnlyFetchOnceSWR } from '@/libs/swr';
import { useCacheScope } from '@/libs/swr/useCacheScope';

import type { AgentStore } from '../../store';
import { BuiltinAgentSliceActionImpl } from './action';

vi.mock('@/libs/swr', () => ({
  useOnlyFetchOnceSWR: vi.fn(() => ({ data: undefined })),
}));

vi.mock('@/libs/swr/useCacheScope', () => ({
  useCacheScope: vi.fn(),
}));

describe('BuiltinAgentSliceActionImpl.useInitBuiltinAgent', () => {
  const get = () => ({}) as AgentStore;
  const set = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCacheScope).mockReturnValue('user-a:workspace-a');
  });

  it('uses the stable user/workspace cache scope for inbox requests', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent(INBOX_SESSION_ID, { brandingRevision: '12', isLogin: true });

    expect(useOnlyFetchOnceSWR).toHaveBeenCalledWith(
      ['builtinAgent:init', 'inbox', '12', 'user-a:workspace-a'],
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('changes the inbox request key when the active workspace changes at the same revision', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent(INBOX_SESSION_ID, { brandingRevision: '12', isLogin: true });
    vi.mocked(useCacheScope).mockReturnValue('user-a:workspace-b');
    action.useInitBuiltinAgent(INBOX_SESSION_ID, { brandingRevision: '12', isLogin: true });

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

  it('disables the inbox request after logout instead of reading the previous user key', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent(INBOX_SESSION_ID, { brandingRevision: '12', isLogin: false });

    expect(useOnlyFetchOnceSWR).toHaveBeenCalledWith(
      null,
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('does not reuse a persisted user key across logout and the next login', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent(INBOX_SESSION_ID, { brandingRevision: '12', isLogin: true });
    action.useInitBuiltinAgent(INBOX_SESSION_ID, { brandingRevision: '12', isLogin: false });
    vi.mocked(useCacheScope).mockReturnValue('user-b:workspace-a');
    action.useInitBuiltinAgent(INBOX_SESSION_ID, { brandingRevision: '12', isLogin: true });

    expect(vi.mocked(useOnlyFetchOnceSWR).mock.calls.map(([key]) => key)).toEqual([
      ['builtinAgent:init', 'inbox', '12', 'user-a:workspace-a'],
      null,
      ['builtinAgent:init', 'inbox', '12', 'user-b:workspace-a'],
    ]);
  });

  it('keeps the existing non-inbox key regardless of cache scope', () => {
    const action = new BuiltinAgentSliceActionImpl(set, get);

    action.useInitBuiltinAgent('page-agent', { brandingRevision: '12', isLogin: true });

    expect(useOnlyFetchOnceSWR).toHaveBeenCalledWith(
      ['builtinAgent:init', 'page-agent'],
      expect.any(Function),
      expect.any(Object),
    );
  });
});
