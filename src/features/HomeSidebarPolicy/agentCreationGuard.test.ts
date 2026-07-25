import { describe, expect, it, vi } from 'vitest';

import { isAgentCreationAllowed, runAgentCreationIfAllowed } from './agentCreationGuard';

describe('Agent and Group Chat creation guard', () => {
  it('fails closed for managed/loading/error capability state', () => {
    expect(isAgentCreationAllowed({ agentCreationBlocked: true, canCreate: true })).toBe(false);
    expect(isAgentCreationAllowed({ agentCreationBlocked: false, canCreate: true })).toBe(true);
  });

  it('prevents the protected mutation callback from reaching an API', async () => {
    const action = vi.fn().mockResolvedValue('created');
    await expect(
      runAgentCreationIfAllowed({
        action,
        agentCreationBlocked: true,
        blockedResult: 'blocked',
        canCreate: true,
      }),
    ).resolves.toBe('blocked');
    expect(action).not.toHaveBeenCalled();
  });
});
