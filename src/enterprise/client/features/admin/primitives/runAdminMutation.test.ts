// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  withAdminReauthRetry: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', () => ({ toast: { error: mocks.toastError } }));
vi.mock('i18next', () => ({ default: { t: (key: string) => `t:${key}` } }));
vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  AdminReauthBlockedError: class AdminReauthBlockedError extends Error {},
  AdminReauthCancelledError: class AdminReauthCancelledError extends Error {},
  withAdminReauthRetry: (...args: unknown[]) => mocks.withAdminReauthRetry(...args),
}));
vi.mock('@/enterprise/client/features/admin/users/utils', () => ({
  getAdminUsersMutationErrorKey: () => 'users.errors.generic',
}));

const { runAdminMutation } = await import('./runAdminMutation');
const { AdminReauthBlockedError, AdminReauthCancelledError } =
  await import('@/enterprise/client/features/admin/reauth/requestAdminReauth');

describe('runAdminMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAdminReauthRetry.mockImplementation(async (run: () => Promise<void>) => run());
  });

  it('runs the mutation through the shared reauth retry and reports the commit', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await expect(runAdminMutation({ authMethod: 'oidc', run })).resolves.toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(mocks.withAdminReauthRetry).toHaveBeenCalledWith(run, { authMethod: 'oidc' });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('toasts a mapped failure and reports that nothing committed', async () => {
    mocks.withAdminReauthRetry.mockRejectedValueOnce(new Error('boom'));
    await expect(runAdminMutation({ run: vi.fn() })).resolves.toBe(false);
    expect(mocks.toastError).toHaveBeenCalledWith('t:users.errors.generic');
  });

  it('gives cancelled and blocked reauth their own copy', async () => {
    mocks.withAdminReauthRetry.mockRejectedValueOnce(new AdminReauthCancelledError());
    await runAdminMutation({ run: vi.fn() });
    expect(mocks.toastError).toHaveBeenLastCalledWith('t:users.errors.reauthCancelled');

    mocks.withAdminReauthRetry.mockRejectedValueOnce(new AdminReauthBlockedError());
    await runAdminMutation({ run: vi.fn() });
    expect(mocks.toastError).toHaveBeenLastCalledWith('t:users.errors.reauthBlocked');
  });

  it('lets a caller own the whole error surface instead of the default toast', async () => {
    const failure = new Error('inline');
    mocks.withAdminReauthRetry.mockRejectedValueOnce(failure);
    const onError = vi.fn();
    await expect(runAdminMutation({ onError, run: vi.fn() })).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('awaits an async error handler before settling', async () => {
    mocks.withAdminReauthRetry.mockRejectedValueOnce(new Error('slow'));
    const seen: string[] = [];
    await runAdminMutation({
      onError: async () => {
        await Promise.resolve();
        seen.push('handled');
      },
      run: vi.fn(),
    });
    expect(seen).toEqual(['handled']);
  });
});
