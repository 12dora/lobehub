// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import { createAdminIdentityProviderRuntime } from '@/server/enterprise/routers/admin/identityProvidersSupport';
import {
  IDENTITY_PROVIDER_TEST_STATE_PREFIX,
  IDENTITY_PROVIDER_TEST_STATE_TOKEN_LENGTH,
  IdentityProviderTestAttemptError,
} from '@/server/enterprise/services/identityProvider/testAttemptStore';

import {
  handleIdentityProviderTestCallback,
  IDENTITY_PROVIDER_TEST_CALLBACK_RATE_LIMIT,
  resetIdentityProviderTestCallbackRateLimitForTest,
  resolveIdentityProviderCallbackOrigin,
} from './identityProviderTestCallback';

const validState = `${IDENTITY_PROVIDER_TEST_STATE_PREFIX}${'A'.repeat(IDENTITY_PROVIDER_TEST_STATE_TOKEN_LENGTH)}`;

vi.mock('@/server/enterprise/routers/admin/identityProvidersSupport', () => ({
  createAdminIdentityProviderRuntime: vi.fn(),
}));

const unusedDb = {} as LobeChatDatabase;

beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://app.example.test');
  resetIdentityProviderTestCallbackRateLimitForTest();
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
        `https://app.example.test/oauth/identity-provider/test/callback?state=${validState}&error=denied&error_description=${encodeURIComponent(attacker)}`,
      ),
      unusedDb,
    );
    expect(abandon).toHaveBeenCalledWith(validState, 'https://app.example.test');
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
        `https://app.example.test/oauth/identity-provider/test/callback?code=code&state=${validState}`,
      ),
      unusedDb,
    );
    expect(await response.text()).toContain('Test failed');
    expect(callback).toHaveBeenCalledWith({
      code: 'code',
      effectiveOrigin: 'https://app.example.test',
      iss: null,
      state: validState,
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
        `https://app.example.test/oauth/identity-provider/test/callback?code=code&state=${validState}&iss=https%3A%2F%2Flogin.example.test%2F`,
      ),
      unusedDb,
    );
    expect(await response.text()).toContain('Test complete');
    expect(callback).toHaveBeenCalledWith({
      code: 'code',
      effectiveOrigin: 'https://app.example.test',
      iss: 'https://login.example.test/',
      state: validState,
    });
  });

  it('rejects a non-canonical Host before runtime construction or DB reservation', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        `https://app.example.test/oauth/identity-provider/test/callback?code=code&state=${validState}`,
        { headers: { host: 'evil.example.test' } },
      ),
      unusedDb,
    );
    expect(createAdminIdentityProviderRuntime).not.toHaveBeenCalled();
    expect(await response.text()).toContain('Test failed');
  });

  it.each([
    ['missing', ''],
    ['wrong prefix', 'other-prefix.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['prefixed but short', `${IDENTITY_PROVIDER_TEST_STATE_PREFIX}short`],
    ['bad charset', `${IDENTITY_PROVIDER_TEST_STATE_PREFIX}${'A'.repeat(42)}/`],
  ])('rejects a %s state before touching the runtime', async (_label, state) => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        `https://app.example.test/oauth/identity-provider/test/callback?code=code&state=${encodeURIComponent(state)}`,
      ),
      unusedDb,
    );
    expect(createAdminIdentityProviderRuntime).not.toHaveBeenCalled();
    expect(await response.text()).toContain('Test failed');
  });

  it('rate-limits a single IP to the terminal page without constructing the runtime', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const callback = vi.fn().mockResolvedValue({ attemptId: 'attempt', valid: true });
    vi.mocked(createAdminIdentityProviderRuntime).mockReturnValue({
      admin: {} as never,
      test: { callback } as never,
    });
    const url = `https://app.example.test/oauth/identity-provider/test/callback?code=code&state=${validState}`;
    const headers = { 'x-real-ip': '203.0.113.10' };

    for (let index = 0; index < IDENTITY_PROVIDER_TEST_CALLBACK_RATE_LIMIT; index += 1) {
      const allowed = await handleIdentityProviderTestCallback(
        new NextRequest(url, { headers }),
        unusedDb,
      );
      expect(await allowed.text()).toContain('Test complete');
    }
    expect(callback).toHaveBeenCalledTimes(IDENTITY_PROVIDER_TEST_CALLBACK_RATE_LIMIT);

    const limited = await handleIdentityProviderTestCallback(
      new NextRequest(url, { headers }),
      unusedDb,
    );
    expect(await limited.text()).toContain('Test failed');
    expect(callback).toHaveBeenCalledTimes(IDENTITY_PROVIDER_TEST_CALLBACK_RATE_LIMIT);

    const otherIp = await handleIdentityProviderTestCallback(
      new NextRequest(url, { headers: { 'x-real-ip': '203.0.113.11' } }),
      unusedDb,
    );
    expect(await otherIp.text()).toContain('Test complete');
    expect(callback).toHaveBeenCalledTimes(IDENTITY_PROVIDER_TEST_CALLBACK_RATE_LIMIT + 1);
  });

  it('logs expected invalid/replayed states at warn, and real failures at error', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new IdentityProviderTestAttemptError('OIDC_TEST_REPLAYED'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    vi.mocked(createAdminIdentityProviderRuntime).mockReturnValue({
      admin: {} as never,
      test: { callback } as never,
    });
    const url = `https://app.example.test/oauth/identity-provider/test/callback?code=code&state=${validState}`;

    await handleIdentityProviderTestCallback(new NextRequest(url), unusedDb);
    expect(warn).toHaveBeenCalledWith(
      '[identity-provider-test] callback rejected',
      expect.objectContaining({ errorClass: 'IdentityProviderTestAttemptError' }),
    );
    expect(error).not.toHaveBeenCalled();

    await handleIdentityProviderTestCallback(new NextRequest(url), unusedDb);
    expect(error).toHaveBeenCalledWith(
      '[identity-provider-test] callback failed',
      expect.objectContaining({ errorClass: 'Error' }),
    );

    warn.mockRestore();
    error.mockRestore();
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
        `https://app.example.test/oauth/identity-provider/test/callback?authCode=AC-1&state=${validState}`,
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
      state: validState,
    });
  });
});
