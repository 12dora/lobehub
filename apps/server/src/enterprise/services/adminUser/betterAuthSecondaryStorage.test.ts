import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteSession = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/auth', () => ({
  auth: {
    $context: Promise.resolve({
      internalAdapter: { deleteSession },
    }),
    api: { getSession: vi.fn() },
  },
}));

describe('deleteBetterAuthSecondaryStorageSessions', () => {
  beforeEach(() => {
    deleteSession.mockClear();
  });

  it('deletes each token through the Better Auth internal adapter', async () => {
    const { deleteBetterAuthSecondaryStorageSessions } =
      await import('./betterAuthSecondaryStorage');

    await deleteBetterAuthSecondaryStorageSessions(['tok-a', 'tok-b']);

    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(deleteSession).toHaveBeenCalledWith('tok-a');
    expect(deleteSession).toHaveBeenCalledWith('tok-b');
  });

  it('no-ops on an empty token list', async () => {
    const { deleteBetterAuthSecondaryStorageSessions } =
      await import('./betterAuthSecondaryStorage');

    await deleteBetterAuthSecondaryStorageSessions([]);

    expect(deleteSession).not.toHaveBeenCalled();
  });
});
