import { describe, expect, it, vi } from 'vitest';

import { commitSharedOAuthThenRefresh } from './SharedOAuthAuthorizationControl';

describe('shared OAuth post-commit refresh boundary', () => {
  it('resolves as committed when refresh rejects', async () => {
    const setSharedAuthorization = vi.fn().mockResolvedValue(undefined);
    const mutate = vi.fn().mockRejectedValue(new Error('swr refresh failed'));

    const result = await commitSharedOAuthThenRefresh({ mutate, setSharedAuthorization });

    expect(setSharedAuthorization).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ committed: true, refreshFailed: true });
  });

  it('does not mark refreshFailed when mutate succeeds', async () => {
    const setSharedAuthorization = vi.fn().mockResolvedValue(undefined);
    const mutate = vi.fn().mockResolvedValue({ revision: 2 });

    const result = await commitSharedOAuthThenRefresh({ mutate, setSharedAuthorization });

    expect(result).toEqual({ committed: true, refreshFailed: false });
  });

  it('propagates mutation failures before refresh is attempted', async () => {
    const setSharedAuthorization = vi.fn().mockRejectedValue(new Error('write failed'));
    const mutate = vi.fn();

    await expect(commitSharedOAuthThenRefresh({ mutate, setSharedAuthorization })).rejects.toThrow(
      'write failed',
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});
