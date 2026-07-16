import { describe, expect, it, vi } from 'vitest';

import {
  ADMIN_REAUTH_MESSAGE_TYPE,
  AdminReauthBlockedError,
  AdminReauthCancelledError,
  createAdminReauthState,
  requestAdminReauth,
  withAdminReauthRetry,
} from './requestAdminReauth';

describe('createAdminReauthState', () => {
  it('uses crypto.getRandomValues (not Math.random)', () => {
    const spy = vi.fn((a: Uint8Array) => {
      a.fill(7);
      return a;
    });
    const state = createAdminReauthState({ getRandomValues: spy });
    expect(spy).toHaveBeenCalled();
    expect(state).toMatch(/^[0-9a-f]+$/);
    expect(state.length).toBe(64);
  });
});

describe('requestAdminReauth binding', () => {
  it('rejects when popup is blocked', async () => {
    await expect(
      requestAdminReauth({
        openWindow: () => null,
        origin: 'https://app.example.com',
        createState: () => 'aa'.repeat(16),
      }),
    ).rejects.toBeInstanceOf(AdminReauthBlockedError);
  });

  it('rejects wrong origin / wrong source / wrong state / replay', async () => {
    const state = 'bb'.repeat(16);
    const popup = { close: vi.fn(), closed: false } as unknown as Window;
    const listeners: Array<(e: MessageEvent) => void> = [];
    const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation((type, handler) => {
      if (type === 'message') listeners.push(handler as (e: MessageEvent) => void);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => undefined);

    let resolved = false;
    const promise = requestAdminReauth({
      openWindow: () => popup,
      origin: 'https://app.example.com',
      createState: () => state,
      pollMs: 50_000,
    }).then(() => {
      resolved = true;
    });

    const emit = (partial: Partial<MessageEvent>) => {
      for (const l of listeners) {
        l({
          data: { status: 'success', state, type: ADMIN_REAUTH_MESSAGE_TYPE },
          origin: 'https://app.example.com',
          source: popup,
          ...partial,
        } as MessageEvent);
      }
    };

    emit({ origin: 'https://evil.example.com' });
    emit({ source: window });
    emit({
      data: { status: 'success', state: 'cc'.repeat(16), type: ADMIN_REAUTH_MESSAGE_TYPE },
    });
    expect(resolved).toBe(false);

    emit({});
    await expect(promise).resolves.toBeUndefined();

    // Replay after consume must not resolve again (already settled)
    emit({});
    expect(popup.close).toHaveBeenCalled();
    addSpy.mockRestore();
  });

  it('abort signal cancels and ignores later success', async () => {
    const state = 'dd'.repeat(16);
    const popup = { close: vi.fn(), closed: false } as unknown as Window;
    const listeners: Array<(e: MessageEvent) => void> = [];
    vi.spyOn(window, 'addEventListener').mockImplementation((type, handler) => {
      if (type === 'message') listeners.push(handler as (e: MessageEvent) => void);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => undefined);

    const ac = new AbortController();
    const promise = requestAdminReauth({
      openWindow: () => popup,
      origin: 'https://app.example.com',
      createState: () => state,
      signal: ac.signal,
      pollMs: 50_000,
    });

    ac.abort();
    await expect(promise).rejects.toBeInstanceOf(AdminReauthCancelledError);

    for (const l of listeners) {
      l({
        data: { status: 'success', state, type: ADMIN_REAUTH_MESSAGE_TYPE },
        origin: 'https://app.example.com',
        source: popup,
      } as MessageEvent);
    }
  });
});

describe('withAdminReauthRetry', () => {
  it('retries exactly once after successful reauth with frozen fn', async () => {
    const payloads: unknown[] = [];
    const frozen = { reason: 'r', includeCurrent: false };
    const fn = vi.fn(async () => {
      payloads.push({ ...frozen });
      if (fn.mock.calls.length === 1) throw new Error('ADMIN_REAUTH_REQUIRED');
      return 'ok';
    });
    const requestReauth = vi.fn().mockResolvedValue(undefined);

    await expect(withAdminReauthRetry(fn, { requestReauth })).resolves.toBe('ok');
    expect(requestReauth).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(payloads).toEqual([frozen, frozen]);
  });

  it('does not retry when reauth is cancelled', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ADMIN_REAUTH_REQUIRED'));
    const requestReauth = vi.fn().mockRejectedValue(new AdminReauthCancelledError());
    await expect(withAdminReauthRetry(fn, { requestReauth })).rejects.toBeInstanceOf(
      AdminReauthCancelledError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('abort during reauth prevents retry', async () => {
    const ac = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('ADMIN_REAUTH_REQUIRED'));
    const requestReauth = vi.fn(async () => {
      ac.abort();
      throw new AdminReauthCancelledError();
    });
    await expect(
      withAdminReauthRetry(fn, { requestReauth, signal: ac.signal }),
    ).rejects.toBeInstanceOf(AdminReauthCancelledError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
