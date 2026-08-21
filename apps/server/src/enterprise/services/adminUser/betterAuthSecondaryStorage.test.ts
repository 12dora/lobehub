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

  it('logs only sanitized error name/code and counts, never command.args tokens', async () => {
    const token = 'raw-session-token-must-not-leak';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    deleteSession.mockRejectedValueOnce(
      Object.assign(new Error('MOVED'), {
        code: 'MOVED',
        command: { args: [`better-auth:${token}`, 'GET'], name: 'GET' },
        name: 'ReplyError',
      }),
    );

    const { deleteBetterAuthSecondaryStorageSessions } =
      await import('./betterAuthSecondaryStorage');

    await deleteBetterAuthSecondaryStorageSessions([token]);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0] ?? [];
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('command');
    expect(serialized).not.toContain('better-auth:');
    expect(logged[1]).toEqual(
      expect.objectContaining({
        code: 'MOVED',
        name: 'ReplyError',
        tokenCount: 1,
      }),
    );

    errorSpy.mockRestore();
  });
});
