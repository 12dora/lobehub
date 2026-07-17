import { describe, expect, it } from 'vitest';

import { buildAdminAgentGetKey, buildAdminAgentListKey } from './swrKeys';

describe('admin Agent SWR keys', () => {
  it('disables both fetches before read permission is granted', () => {
    expect(buildAdminAgentListKey({}, false)).toBeNull();
    expect(buildAdminAgentGetKey('agent-1', false)).toBeNull();
    expect(buildAdminAgentGetKey(undefined, true)).toBeNull();
  });

  it('includes every list input in the stable key', () => {
    expect(buildAdminAgentListKey({ query: 'research', status: 'draft' }, true)).toEqual([
      'enterprise.admin.agents.list',
      { query: 'research', status: 'draft' },
    ]);
  });
});
