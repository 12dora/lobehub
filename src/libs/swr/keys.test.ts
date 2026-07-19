import { describe, expect, it } from 'vitest';

import { builtinAgentKeys, recentKeys } from './keys';
import { buildCacheScope } from './useCacheScope';

describe('builtinAgentKeys', () => {
  it('tracks Published branding revisions only when the caller supplies one', () => {
    expect(builtinAgentKeys.init('inbox', '12', 'user-1:personal')).toEqual([
      'builtinAgent:init',
      'inbox',
      '12',
      'user-1:personal',
    ]);
    expect(builtinAgentKeys.init('inbox', '13', 'user-1:personal')).toEqual([
      'builtinAgent:init',
      'inbox',
      '13',
      'user-1:personal',
    ]);
    expect(builtinAgentKeys.init('inbox', null, 'user-1:personal')).toEqual([
      'builtinAgent:init',
      'inbox',
      null,
      'user-1:personal',
    ]);
  });

  it('keeps the non-inbox key byte-for-byte unchanged', () => {
    expect(builtinAgentKeys.init('page-agent')).toEqual(['builtinAgent:init', 'page-agent']);
    expect(JSON.stringify(builtinAgentKeys.init('page-agent'))).toBe(
      JSON.stringify(['builtinAgent:init', 'page-agent']),
    );
  });

  it('isolates same-revision inbox data when the active workspace changes', () => {
    const workspaceA = buildCacheScope('user-a', 'workspace-a');
    const workspaceB = buildCacheScope('user-a', 'workspace-b');

    expect(builtinAgentKeys.init('inbox', '12', workspaceA)).not.toEqual(
      builtinAgentKeys.init('inbox', '12', workspaceB),
    );
  });

  it('does not reuse a persisted user key during logout and a following user switch', () => {
    const persistedUserA = buildCacheScope('user-a', 'workspace-a');
    const resolvedAnonymous = buildCacheScope(undefined, undefined);
    const userB = buildCacheScope('user-b', 'workspace-a');
    const keys = [persistedUserA, resolvedAnonymous, userB].map((scope) =>
      builtinAgentKeys.init('inbox', '12', scope),
    );

    expect(new Set(keys.map(JSON.stringify))).toHaveLength(3);
  });
});

describe('recentKeys', () => {
  it('keys the Home recent list by identity cache scope', () => {
    expect(recentKeys.list(true, 10, 'user-1:workspace-1')).toEqual([
      'recent:list',
      true,
      10,
      'user-1:workspace-1',
    ]);
  });

  it('keeps users isolated in the same workspace', () => {
    expect(recentKeys.list(true, 10, 'user-1:workspace-1')).not.toEqual(
      recentKeys.list(true, 10, 'user-2:workspace-1'),
    );
  });

  it('keeps workspaces isolated for the same user', () => {
    expect(recentKeys.allDrawer(true, 'user-1:workspace-1')).not.toEqual(
      recentKeys.allDrawer(true, 'user-1:workspace-2'),
    );
  });
});
