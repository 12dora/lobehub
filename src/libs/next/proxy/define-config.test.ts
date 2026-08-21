/**
 * @vitest-environment node
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defineConfig } from './define-config';

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth.proxy', () => ({
  isUnknownProxySession: (session: { status?: string } | null | undefined) =>
    session?.status === 'unknown',
  proxyAuth: { api: { getSession: getSessionMock } },
}));

const { middleware } = defineConfig();

const run = async (url: string) => {
  const res = await middleware(new NextRequest(url));
  return res?.headers.get('x-middleware-rewrite');
};

beforeEach(() => {
  getSessionMock.mockResolvedValue(null);
});

describe('defineConfig locale path-traversal hardening', () => {
  it('rewrites a normal locale into /spa-auth/<locale>', async () => {
    const rewrite = await run('http://localhost:3010/signin?hl=ja-JP');
    expect(new URL(rewrite!).pathname).toBe('/spa-auth/ja-JP/signin');
  });

  it('falls back to en-US for a traversal locale (plain)', async () => {
    const rewrite = await run('http://localhost:3010/signin?hl=../../api/dev/x');
    const { pathname } = new URL(rewrite!);
    expect(pathname.startsWith('/spa-auth/')).toBe(true);
    expect(pathname).toBe('/spa-auth/en-US/signin');
  });

  it('falls back to en-US for a traversal locale (percent-encoded)', async () => {
    const rewrite = await run('http://localhost:3010/signin?hl=..%2F..%2Fapi%2Fdev%2Fx');
    const { pathname } = new URL(rewrite!);
    expect(pathname.startsWith('/spa-auth/')).toBe(true);
    expect(pathname).toBe('/spa-auth/en-US/signin');
  });
});

describe('defineConfig SPA rewrites', () => {
  it.each(['/admin', '/admin/agents'])(
    'rewrites an authenticated %s route to the SPA',
    async (path) => {
      getSessionMock.mockResolvedValue({ user: { id: 'admin-user' } });

      const rewrite = await run(`http://localhost:3010${path}`);

      expect(new URL(rewrite!).pathname).toMatch(new RegExp(`^/spa/[^/]+${path}$`));
    },
  );
});

describe('defineConfig session gating', () => {
  it('does not redirect to sign-in when session lookup is unknown', async () => {
    getSessionMock.mockResolvedValue({ status: 'unknown' });

    const response = await middleware(new NextRequest('http://localhost:3010/chat'));

    expect(response?.headers.get('location')).toBeNull();
    expect(response?.headers.get('x-middleware-rewrite')).toBeTruthy();
  });

  it('redirects to sign-in only when the session is definitively empty', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await middleware(new NextRequest('http://localhost:3010/chat'));

    expect(response?.headers.get('location')).toContain('/signin');
  });
});

describe('defineConfig public routes', () => {
  /**
   * The DingTalk callback shim is the sign-in itself: it arrives from DingTalk before the user
   * has any session. Session-gating it would redirect the callback to /signin and production
   * login could never complete. A handler-only test cannot catch this — it bypasses middleware.
   */
  it('lets the unauthenticated DingTalk callback shim through to its route handler', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await middleware(
      new NextRequest(
        'http://localhost:3010/oauth/identity-provider/dingtalk/dingtalk?authCode=AC-1&state=S-1',
      ),
    );

    // No redirect to /signin, and no SPA rewrite: the request reaches the backend route.
    expect(response?.headers.get('location')).toBeNull();
    expect(response?.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('lets the unauthenticated test callback reach its handler', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await middleware(
      new NextRequest(
        'http://localhost:3010/oauth/identity-provider/test/callback?code=C-1&state=S-1',
      ),
    );

    // The handler never reads the session; the one-time high-entropy `state` is the capability.
    expect(response?.headers.get('location')).toBeNull();
    expect(response?.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('keeps siblings of the test callback session-gated', async () => {
    getSessionMock.mockResolvedValue(null);

    for (const path of [
      '/oauth/identity-provider/test',
      '/oauth/identity-provider/test/other',
      '/oauth/identity-provider/test/callback/extra',
    ]) {
      const response = await middleware(new NextRequest(`http://localhost:3010${path}`));
      expect(response?.headers.get('location'), path).toContain('/signin');
    }
  });

  it('does not expose the rest of the /oauth/identity-provider tree', async () => {
    getSessionMock.mockResolvedValue(null);

    for (const path of [
      '/oauth/identity-provider',
      '/oauth/identity-provider/dingtalkX/evil',
      '/oauth/identity-provider/other/dingtalk/x',
    ]) {
      const response = await middleware(new NextRequest(`http://localhost:3010${path}`));
      expect(response?.headers.get('location'), path).toContain('/signin');
    }
  });
});
