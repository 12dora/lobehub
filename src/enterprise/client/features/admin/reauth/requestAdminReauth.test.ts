import { describe, expect, it, vi } from 'vitest';

import {
  ADMIN_REAUTH_MESSAGE_TYPE,
  AdminReauthBlockedError,
  AdminReauthCancelledError,
  requestAdminReauth,
  withAdminReauthRetry,
} from './requestAdminReauth';

describe('requestAdminReauth', () => {
  it('rejects when popup is blocked', async () => {
    await expect(
      requestAdminReauth({
        openWindow: () => null,
        origin: 'https://app.example.com',
      }),
    ).rejects.toBeInstanceOf(AdminReauthBlockedError);
  });

  it('resolves on same-origin success message and never stores reason', async () => {
    const popup = { close: vi.fn(), closed: false } as unknown as Window;
    const listeners: Array<(e: MessageEvent) => void> = [];
    const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation((type, handler) => {
      if (type === 'message') listeners.push(handler as (e: MessageEvent) => void);
    });
    const removeSpy = vi.spyOn(window, 'removeEventListener').mockImplementation(() => undefined);

    const promise = requestAdminReauth({
      openWindow: () => popup,
      origin: 'https://app.example.com',
      pollMs: 10_000,
    });

    // Foreign origin must be ignored
    for (const l of listeners) {
      l({
        data: { status: 'success', type: ADMIN_REAUTH_MESSAGE_TYPE },
        origin: 'https://evil.example.com',
      } as MessageEvent);
    }

    for (const l of listeners) {
      l({
        data: { status: 'success', type: ADMIN_REAUTH_MESSAGE_TYPE },
        origin: 'https://app.example.com',
      } as MessageEvent);
    }

    await expect(promise).resolves.toBeUndefined();
    expect(popup.close).toHaveBeenCalled();
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('rejects when popup is closed without success', async () => {
    const popup = { close: vi.fn(), closed: false } as { close: () => void; closed: boolean };
    const promise = requestAdminReauth({
      openWindow: () => popup as unknown as Window,
      origin: 'https://app.example.com',
      pollMs: 20,
    });
    popup.closed = true;
    await expect(promise).rejects.toBeInstanceOf(AdminReauthCancelledError);
  });
});

describe('withAdminReauthRetry', () => {
  it('retries exactly once after successful reauth', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ADMIN_REAUTH_REQUIRED'))
      .mockResolvedValueOnce('ok');
    const requestReauth = vi.fn().mockResolvedValue(undefined);

    await expect(withAdminReauthRetry(fn, { requestReauth })).resolves.toBe('ok');
    expect(requestReauth).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when reauth is cancelled', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ADMIN_REAUTH_REQUIRED'));
    const requestReauth = vi.fn().mockRejectedValue(new AdminReauthCancelledError());

    await expect(withAdminReauthRetry(fn, { requestReauth })).rejects.toBeInstanceOf(
      AdminReauthCancelledError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not reauth for non-reauth errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('PLATFORM_INVALID_INPUT'));
    const requestReauth = vi.fn();
    await expect(withAdminReauthRetry(fn, { requestReauth })).rejects.toThrow(
      'PLATFORM_INVALID_INPUT',
    );
    expect(requestReauth).not.toHaveBeenCalled();
  });
});
