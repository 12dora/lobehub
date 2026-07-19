import { describe, expect, it } from 'vitest';

import { builtinAgentKeys, recentKeys } from './keys';

describe('builtinAgentKeys', () => {
  it('tracks Published branding revisions only when the caller supplies one', () => {
    expect(builtinAgentKeys.init('inbox', '12')).toEqual(['builtinAgent:init', 'inbox', '12']);
    expect(builtinAgentKeys.init('inbox', '13')).toEqual(['builtinAgent:init', 'inbox', '13']);
    expect(builtinAgentKeys.init('inbox', null)).toEqual(['builtinAgent:init', 'inbox', null]);
  });

  it('dedupes the same revision and leaves non-inbox keys revision-free', () => {
    expect(builtinAgentKeys.init('inbox', '12')).toEqual(builtinAgentKeys.init('inbox', '12'));
    expect(builtinAgentKeys.init('page-agent')).toEqual(['builtinAgent:init', 'page-agent']);
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
