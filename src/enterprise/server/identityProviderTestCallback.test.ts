// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import { createAdminIdentityProviderRuntime } from '@/server/enterprise/routers/admin/identityProvidersSupport';

import {
  handleIdentityProviderTestCallback,
  resolveIdentityProviderCallbackOrigin,
} from './identityProviderTestCallback';

vi.mock('@/server/enterprise/routers/admin/identityProvidersSupport', () => ({
  createAdminIdentityProviderRuntime: vi.fn(),
}));

const unusedDb = {} as LobeChatDatabase;

beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://app.example.test');
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('handleIdentityProviderTestCallback', () => {
  it('is a no-runtime terminal page while the feature is disabled', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '0');
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        'https://app.example.test/oauth/identity-provider/test/callback?code=x&state=y',
      ),
      unusedDb,
    );
    expect(createAdminIdentityProviderRuntime).not.toHaveBeenCalled();
    expect(await response.text()).toContain('Test failed');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('terminally abandons provider errors without reflecting attacker strings', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const abandon = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createAdminIdentityProviderRuntime).mockReturnValue({
      admin: {} as never,
      test: { abandon } as never,
    });
    const attacker = '</script><script>alert(1)</script>';
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        `https://app.example.test/oauth/identity-provider/test/callback?state=safe&error=denied&error_description=${encodeURIComponent(attacker)}`,
      ),
      unusedDb,
    );
    expect(abandon).toHaveBeenCalledWith('safe', 'https://app.example.test');
    expect(await response.text()).not.toContain(attacker);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('renders a claim-validation rejection as terminal failure', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const callback = vi.fn().mockResolvedValue({ attemptId: 'attempt', valid: false });
    vi.mocked(createAdminIdentityProviderRuntime).mockReturnValue({
      admin: {} as never,
      test: { callback } as never,
    });
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        'https://app.example.test/oauth/identity-provider/test/callback?code=code&state=state',
      ),
      unusedDb,
    );
    expect(await response.text()).toContain('Test failed');
    expect(callback).toHaveBeenCalledWith({
      code: 'code',
      effectiveOrigin: 'https://app.example.test',
      iss: null,
      state: 'state',
    });
  });

  it('forwards the RFC 9207 authorization-response iss parameter when present', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const callback = vi.fn().mockResolvedValue({ attemptId: 'attempt', valid: true });
    vi.mocked(createAdminIdentityProviderRuntime).mockReturnValue({
      admin: {} as never,
      test: { callback } as never,
    });
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        'https://app.example.test/oauth/identity-provider/test/callback?code=code&state=state&iss=https%3A%2F%2Flogin.example.test%2F',
      ),
      unusedDb,
    );
    expect(await response.text()).toContain('Test complete');
    expect(callback).toHaveBeenCalledWith({
      code: 'code',
      effectiveOrigin: 'https://app.example.test',
      iss: 'https://login.example.test/',
      state: 'state',
    });
  });

  it('rejects a non-canonical Host before runtime construction or DB reservation', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        'https://app.example.test/oauth/identity-provider/test/callback?code=code&state=state',
        { headers: { host: 'evil.example.test' } },
      ),
      unusedDb,
    );
    expect(createAdminIdentityProviderRuntime).not.toHaveBeenCalled();
    expect(await response.text()).toContain('Test failed');
  });
});

describe('resolveIdentityProviderCallbackOrigin', () => {
  it('uses Host and ignores forwarded headers unless proxy trust is explicit', () => {
    const request = new NextRequest('https://app.example.test/callback', {
      headers: {
        'host': 'app.example.test',
        'x-forwarded-host': 'evil.example.test',
        'x-forwarded-proto': 'http',
      },
    });
    expect(
      resolveIdentityProviderCallbackOrigin(request, { APP_URL: 'https://app.example.test' }),
    ).toBe('https://app.example.test');
  });

  it('uses unambiguous forwarded proto/host/port only for a trusted proxy', () => {
    const request = new NextRequest('http://internal:3000/callback', {
      headers: {
        'host': 'internal:3000',
        'x-forwarded-host': 'app.example.test',
        'x-forwarded-port': '443',
        'x-forwarded-proto': 'https',
      },
    });
    expect(
      resolveIdentityProviderCallbackOrigin(request, {
        APP_URL: 'https://app.example.test',
        OIDC_TRUST_PROXY_HEADERS: '1',
      }),
    ).toBe('https://app.example.test');
  });

  it.each([
    [{ host: 'evil.example.test' }, {}],
    [{ host: 'app.example.test,evil.example.test' }, {}],
    [
      {
        'host': 'internal:3000',
        'x-forwarded-host': 'app.example.test',
        'x-forwarded-port': '8443',
        'x-forwarded-proto': 'https',
      },
      { OIDC_TRUST_PROXY_HEADERS: '1' },
    ],
  ])('rejects host/proxy ambiguity or a non-canonical port', (headers, extraEnv) => {
    const request = new NextRequest('https://app.example.test/callback', { headers });
    expect(() =>
      resolveIdentityProviderCallbackOrigin(request, {
        APP_URL: 'https://app.example.test',
        ...extraEnv,
      }),
    ).toThrow('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
  });

  it('accepts an explicitly configured fallback origin for trusted proxy routing', () => {
    const request = new NextRequest('http://internal/callback', {
      headers: {
        'host': 'internal',
        'x-forwarded-host': 'fallback.example.test',
        'x-forwarded-proto': 'https',
      },
    });
    expect(
      resolveIdentityProviderCallbackOrigin(request, {
        APP_URL: 'https://app.example.test',
        AUTH_TRUSTED_ORIGINS: 'https://fallback.example.test',
        OIDC_TRUST_PROXY_HEADERS: 'true',
      }),
    ).toBe('https://fallback.example.test');
  });
});

describe('DingTalk authCode parameter', () => {
  it("accepts DingTalk's `authCode` as the authorization code", async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const callback = vi.fn().mockResolvedValue({ attemptId: 'attempt', valid: true });
    const abandon = vi.fn();
    vi.mocked(createAdminIdentityProviderRuntime).mockReturnValue({
      admin: {} as never,
      test: { abandon, callback } as never,
    });
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        'https://app.example.test/oauth/identity-provider/test/callback?authCode=AC-1&state=state',
      ),
      unusedDb,
    );
    expect(await response.text()).toContain('Test complete');
    // DingTalk's 统一登录 never sends `code`; without this the attempt would be abandoned.
    expect(abandon).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: 'AC-1',
      effectiveOrigin: 'https://app.example.test',
      iss: null,
      state: 'state',
    });
  });
});
