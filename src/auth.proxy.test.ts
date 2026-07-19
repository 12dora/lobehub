/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { proxyAuth } from './auth.proxy';

const getCookieCache = vi.hoisted(() => vi.fn());

vi.mock('better-auth/cookies', () => ({ getCookieCache }));

const headers = new Headers({ cookie: 'better-auth.session_data=signed' });
const cachedSession = () => ({
  session: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
  updatedAt: Date.now(),
  user: { id: 'user-1' },
});

beforeEach(() => {
  process.env.APP_URL = 'https://app.example.test';
  process.env.AUTH_SECRET = 'test-auth-secret-that-is-long-enough';
  getCookieCache.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

describe('edge-safe proxy auth', () => {
  it('accepts a fresh signed cookie cache without a server lookup', async () => {
    getCookieCache.mockResolvedValue(cachedSession());

    await expect(
      proxyAuth.api.getSession({ headers, requestUrl: 'https://app.example.test/admin' }),
    ).resolves.toMatchObject({ user: { id: 'user-1' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the authoritative internal session endpoint when the cache is stale', async () => {
    getCookieCache.mockResolvedValue({
      ...cachedSession(),
      updatedAt: Date.now() - 10 * 60_000,
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(cachedSession()), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );

    await expect(
      proxyAuth.api.getSession({ headers, requestUrl: 'https://app.example.test/admin' }),
    ).resolves.toMatchObject({ user: { id: 'user-1' } });
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://app.example.test/api/auth/get-session?disableCookieCache=true'),
      expect.objectContaining({ headers: { cookie: 'better-auth.session_data=signed' } }),
    );
  });

  it('fails closed on unsigned, expired, or unavailable session evidence', async () => {
    getCookieCache.mockResolvedValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('unavailable'));

    await expect(
      proxyAuth.api.getSession({ headers, requestUrl: 'https://app.example.test/admin' }),
    ).resolves.toBeNull();
  });
});
