/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCookieCache = vi.hoisted(() => vi.fn());

vi.mock('better-auth/cookies', () => ({ getCookieCache }));

const headers = new Headers({ cookie: 'better-auth.session_data=signed' });
const cachedSession = () => ({
  session: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
  updatedAt: Date.now(),
  user: { id: 'user-1' },
});

const loadProxyAuth = async (env: { appUrl?: string; internalUrl?: string } = {}) => {
  vi.resetModules();
  if (env.appUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = env.appUrl;
  if (env.internalUrl === undefined) delete process.env.INTERNAL_APP_URL;
  else process.env.INTERNAL_APP_URL = env.internalUrl;
  return (await import('./auth.proxy')).proxyAuth;
};

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-auth-secret-that-is-long-enough';
  getCookieCache.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.APP_URL;
  delete process.env.INTERNAL_APP_URL;
});

describe('edge-safe proxy auth', () => {
  it('accepts a fresh signed cookie cache without a server lookup', async () => {
    const proxyAuth = await loadProxyAuth({ appUrl: 'https://app.example.test' });
    getCookieCache.mockResolvedValue(cachedSession());

    await expect(
      proxyAuth.api.getSession({ headers, requestUrl: 'https://hostile.test:8443/admin' }),
    ).resolves.toMatchObject({ user: { id: 'user-1' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses only the trusted internal origin and session cookie allowlist', async () => {
    const proxyAuth = await loadProxyAuth({
      appUrl: 'https://public.example.test',
      internalUrl: 'http://identity-internal:3210',
    });
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
    const hostileHeaders = new Headers({
      'cookie':
        'analytics=private; better-auth.session_token=token; admin-secret=do-not-forward; better-auth.session_data.0=chunk',
      'forwarded': 'host=evil.test;proto=http',
      'host': 'evil.test:9443',
      'x-forwarded-host': 'evil.test',
      'x-forwarded-port': '9443',
      'x-forwarded-proto': 'http',
    });

    await expect(
      proxyAuth.api.getSession({
        headers: hostileHeaders,
        requestUrl: 'http://evil.test:9443/admin',
      }),
    ).resolves.toMatchObject({ user: { id: 'user-1' } });
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://identity-internal:3210/api/auth/get-session?disableCookieCache=true'),
      expect.objectContaining({
        headers: {
          cookie: 'better-auth.session_token=token; better-auth.session_data.0=chunk',
        },
        redirect: 'error',
      }),
    );
  });

  it.each([
    ['missing trusted origin', undefined],
    ['request-derived origin', 'https://app.example.test/path'],
    ['credential-bearing origin', 'https://user:pass@app.example.test'],
    ['non-local insecure public origin', 'http://app.example.test'],
  ])('fails closed for %s', async (_label, appUrl) => {
    const proxyAuth = await loadProxyAuth({ appUrl });
    getCookieCache.mockResolvedValue(cachedSession());

    await expect(
      proxyAuth.api.getSession({ headers, requestUrl: 'https://attacker.test/admin' }),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed on redirects, unsigned evidence, or unavailable auth', async () => {
    const proxyAuth = await loadProxyAuth({ appUrl: 'https://app.example.test' });
    getCookieCache.mockResolvedValue(null);
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { headers: { location: 'https://evil.test' }, status: 302 }),
    );

    await expect(proxyAuth.api.getSession({ headers })).resolves.toBeNull();
  });
});
