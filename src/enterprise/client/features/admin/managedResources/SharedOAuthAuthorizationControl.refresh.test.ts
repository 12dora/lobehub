import { describe, expect, it, vi } from 'vitest';

/**
 * Documents the commit-boundary for setSharedAuthorization:
 * mutation success is authoritative; SWR refresh failure must not reject.
 * Mirrors the control's try/catch around mutate() after a successful write.
 */
const commitSharedOAuthThenRefresh = async (params: {
  mutate: () => Promise<unknown>;
  setSharedAuthorization: () => Promise<void>;
}): Promise<{ committed: true; refreshFailed: boolean }> => {
  await params.setSharedAuthorization();
  try {
    await params.mutate();
    return { committed: true, refreshFailed: false };
  } catch {
    return { committed: true, refreshFailed: true };
  }
};

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
