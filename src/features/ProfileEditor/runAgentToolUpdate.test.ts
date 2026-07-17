import { describe, expect, it, vi } from 'vitest';

import { runAgentToolUpdate } from './runAgentToolUpdate';

describe('runAgentToolUpdate', () => {
  it('clears the loading state when updateAgentConfig rejects', async () => {
    const states: boolean[] = [];
    const updateAgentConfig = vi.fn().mockRejectedValue(new Error('save rejected'));

    await expect(
      runAgentToolUpdate((updating) => states.push(updating), updateAgentConfig),
    ).rejects.toThrow('save rejected');

    expect(states).toEqual([true, false]);
    expect(updateAgentConfig).toHaveBeenCalledOnce();
  });
});
