import { describe, expect, it } from 'vitest';

import { buildAdminAgentGetKey, buildAdminAgentRolloutPollKey } from './swrKeys';

describe('admin Agent SWR keys', () => {
  it('disables detail fetches before read permission is granted or id is missing', () => {
    expect(buildAdminAgentGetKey('agent-1', false)).toBeNull();
    expect(buildAdminAgentGetKey(undefined, true)).toBeNull();
  });

  it('includes id and rollouts capability in the detail key', () => {
    expect(buildAdminAgentGetKey('agent-1', true, true)).toEqual([
      'enterprise.admin.agents.get',
      'agent-1',
      true,
    ]);
  });

  it('builds a rollout poll key only when there are active jobs', () => {
    expect(buildAdminAgentRolloutPollKey('agent-1', [])).toBeNull();
    expect(buildAdminAgentRolloutPollKey('agent-1', ['job-1'])).toEqual([
      'enterprise.admin.agents.rollout-poll',
      'agent-1',
      ['job-1'],
    ]);
  });
});
