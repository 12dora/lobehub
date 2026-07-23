import { describe, expect, it, vi } from 'vitest';

import { runPostCommitRefresh } from './settingsPolicyPostCommitRefresh';

describe('runPostCommitRefresh', () => {
  it('returns ok when mutate and refresh succeed', async () => {
    const mutate = vi.fn().mockResolvedValue({});
    const refresh = vi.fn().mockResolvedValue(undefined);
    await expect(
      runPostCommitRefresh({ errorMessage: 'failed', mutate, refresh }),
    ).resolves.toEqual({ ok: true });
    expect(mutate).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('returns error when mutate rejects without treating it as thrown', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('network'));
    await expect(
      runPostCommitRefresh({ errorMessage: 'settingsPolicy.refresh.failed', mutate }),
    ).resolves.toEqual({ error: 'settingsPolicy.refresh.failed', ok: false });
  });

  it('returns error when refresh rejects after mutate succeeds', async () => {
    const mutate = vi.fn().mockResolvedValue({});
    const refresh = vi.fn().mockRejectedValue(new Error('swr'));
    await expect(
      runPostCommitRefresh({ errorMessage: 'failed', mutate, refresh }),
    ).resolves.toEqual({ error: 'failed', ok: false });
  });
});
