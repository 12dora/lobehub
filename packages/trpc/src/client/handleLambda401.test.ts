import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleNonAdminLambda401,
  probeBetterAuthSession,
  resetHandleLambda401State,
  SESSION_PROBE_TIMEOUT_MS,
  shouldLogoutAfterSessionProbe,
} from './handleLambda401';

const jsonResponse = (body: unknown, status = 200, contentType = 'application/json') =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': contentType },
    status,
  });

describe('probeBetterAuthSession', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns authenticated when get-session has a user', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ user: { id: 'user-1' } }));

    await expect(probeBetterAuthSession(fetchImpl)).resolves.toBe('authenticated');
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/get-session?disableCookieCache=true',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
        method: 'GET',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('returns unauthenticated on 200 empty / 401', async () => {
    await expect(
      probeBetterAuthSession(vi.fn().mockResolvedValue(jsonResponse(null))),
    ).resolves.toBe('unauthenticated');
    await expect(
      probeBetterAuthSession(vi.fn().mockResolvedValue(new Response('', { status: 401 }))),
    ).resolves.toBe('unauthenticated');
  });

  it('returns unknown on 5xx, 429, non-JSON, or network error', async () => {
    await expect(
      probeBetterAuthSession(vi.fn().mockResolvedValue(new Response('err', { status: 500 }))),
    ).resolves.toBe('unknown');
    await expect(
      probeBetterAuthSession(vi.fn().mockResolvedValue(new Response('slow', { status: 429 }))),
    ).resolves.toBe('unknown');
    await expect(
      probeBetterAuthSession(
        vi
          .fn()
          .mockResolvedValue(
            new Response('<html>', { headers: { 'content-type': 'text/html' }, status: 200 }),
          ),
      ),
    ).resolves.toBe('unknown');
    await expect(
      probeBetterAuthSession(vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))),
    ).resolves.toBe('unknown');
  });

  it('does not trust a cookie-cache session once the backing row is revoked', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('disableCookieCache=true')) {
        return jsonResponse(null);
      }
      return jsonResponse({ user: { id: 'cached-user' } });
    });

    await expect(probeBetterAuthSession(fetchImpl)).resolves.toBe('unauthenticated');
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/get-session?disableCookieCache=true',
      expect.objectContaining({ cache: 'no-store', credentials: 'include', method: 'GET' }),
    );
  });

  it('classifies a never-resolving probe as unknown after the abort timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });

    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const onAbort = () => {
          reject(new DOMException('The operation was aborted.', 'TimeoutError'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const result = probeBetterAuthSession(fetchImpl);
    await vi.advanceTimersByTimeAsync(SESSION_PROBE_TIMEOUT_MS);
    await expect(result).resolves.toBe('unknown');
    vi.useRealTimers();
  });
});

describe('shouldLogoutAfterSessionProbe', () => {
  it('only logs out on a definitive empty session', () => {
    expect(shouldLogoutAfterSessionProbe('unauthenticated')).toBe(true);
    expect(shouldLogoutAfterSessionProbe('authenticated')).toBe(false);
    expect(shouldLogoutAfterSessionProbe('unknown')).toBe(false);
  });
});

describe('handleNonAdminLambda401', () => {
  beforeEach(() => {
    resetHandleLambda401State();
  });

  afterEach(() => {
    resetHandleLambda401State();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not logout when get-session still has a user', async () => {
    const logout = vi.fn();
    const redirectToLogin = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ user: { id: 'user-1' } }));

    await handleNonAdminLambda401({ isSignedIn: true, logout, redirectToLogin }, fetchImpl);

    expect(logout).not.toHaveBeenCalled();
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it('logs out only when get-session is empty or 401', async () => {
    const logout = vi.fn();
    const redirectToLogin = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null));

    await handleNonAdminLambda401({ isSignedIn: true, logout, redirectToLogin }, fetchImpl);

    expect(logout).toHaveBeenCalledOnce();
    expect(redirectToLogin).toHaveBeenCalledOnce();
  });

  it('does not logout on probe network error or 5xx', async () => {
    const logout = vi.fn();
    const redirectToLogin = vi.fn();

    await handleNonAdminLambda401(
      { isSignedIn: true, logout, redirectToLogin },
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    expect(logout).not.toHaveBeenCalled();
    expect(redirectToLogin).not.toHaveBeenCalled();

    resetHandleLambda401State();

    await handleNonAdminLambda401(
      { isSignedIn: true, logout, redirectToLogin },
      vi.fn().mockResolvedValue(new Response('err', { status: 503 })),
    );
    expect(logout).not.toHaveBeenCalled();
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it('dedupes concurrent 401s through a single get-session probe', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const redirectToLogin = vi.fn();
    let resolveFetch: (value: Response) => void = () => undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = handleNonAdminLambda401({ isSignedIn: true, logout, redirectToLogin }, fetchImpl);
    const second = handleNonAdminLambda401(
      { isSignedIn: true, logout, redirectToLogin },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    resolveFetch(jsonResponse(null));
    await Promise.all([first, second]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
    expect(redirectToLogin).toHaveBeenCalledOnce();
  });

  it('does not logout when the probe never resolves and times out as unknown', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });

    const logout = vi.fn();
    const redirectToLogin = vi.fn();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const onAbort = () => {
          reject(new DOMException('The operation was aborted.', 'TimeoutError'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const pending = handleNonAdminLambda401(
      { isSignedIn: true, logout, redirectToLogin },
      fetchImpl,
    );
    await vi.advanceTimersByTimeAsync(SESSION_PROBE_TIMEOUT_MS);
    await pending;

    expect(logout).not.toHaveBeenCalled();
    expect(redirectToLogin).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
