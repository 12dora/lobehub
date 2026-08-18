import { APIError } from 'better-auth/api';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSignInChallengeUrl,
  isTwoFactorChallengeBody,
  NAVIGATION_2FA_CHALLENGE_PATHS,
  rewriteNavigationTwoFactorChallenge,
  sanitizeServerCallbackUrl,
  SIGN_IN_PATH,
} from './navigation-challenge-redirect';

vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://app.example.test' },
}));

const TWO_FACTOR_COOKIE = 'better-auth.two_factor=2fa-abc; Path=/; HttpOnly; SameSite=Lax';
const EXPIRED_SESSION_COOKIE = 'better-auth.session_token=; Max-Age=0; Path=/';

const makeCtx = (params: { callbackURL?: string; returned?: unknown; setCookies?: string[] }) => {
  const accumulated = new Headers();
  for (const cookie of params.setCookies ?? [TWO_FACTOR_COOKIE, EXPIRED_SESSION_COOKIE]) {
    accumulated.append('set-cookie', cookie);
  }

  return {
    accumulated,
    ctx: {
      context: {
        responseHeaders: accumulated,
        returned: params.returned ?? { twoFactorMethods: ['totp'], twoFactorRedirect: true },
      },
      query: params.callbackURL === undefined ? {} : { callbackURL: params.callbackURL },
    },
  };
};

const expectRedirect = (fn: () => void) => {
  try {
    fn();
    expect.unreachable('expected a redirect');
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    return error as InstanceType<typeof APIError> & { headers?: Headers };
  }
};

describe('NAVIGATION_2FA_CHALLENGE_PATHS', () => {
  it('covers the email-link navigations and not the fetch/OTP or OAuth paths', () => {
    expect([...NAVIGATION_2FA_CHALLENGE_PATHS]).toEqual(['/magic-link/verify', '/verify-email']);
  });
});

describe('isTwoFactorChallengeBody', () => {
  it('accepts the stock challenge JSON and the ctx.json wrapper', () => {
    expect(isTwoFactorChallengeBody({ twoFactorRedirect: true })).toBe(true);
    expect(
      isTwoFactorChallengeBody({
        _flag: 'json',
        body: { twoFactorMethods: ['totp'], twoFactorRedirect: true },
      }),
    ).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isTwoFactorChallengeBody({ token: 'sess' })).toBe(false);
    expect(isTwoFactorChallengeBody({ twoFactorRedirect: false })).toBe(false);
    expect(isTwoFactorChallengeBody(null)).toBe(false);
  });
});

describe('sanitizeServerCallbackUrl', () => {
  it('keeps a same-site relative path and a same-origin absolute URL', () => {
    expect(sanitizeServerCallbackUrl('/dashboard?x=1')).toBe('/dashboard?x=1');
    expect(sanitizeServerCallbackUrl('https://app.example.test/chat')).toBe('/chat');
  });

  it('drops an open redirect', () => {
    expect(sanitizeServerCallbackUrl('https://evil.com')).toBe('/');
    expect(sanitizeServerCallbackUrl('//evil.com')).toBe('/');
  });
});

describe('buildSignInChallengeUrl', () => {
  it('threads the original callback through the sign-in page', () => {
    expect(buildSignInChallengeUrl('/dashboard')).toBe(
      `${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent('/dashboard')}`,
    );
  });
});

const headersOf = (error: InstanceType<typeof APIError> & { headers?: HeadersInit }) =>
  new Headers(error.headers);

describe('rewriteNavigationTwoFactorChallenge', () => {
  it('leaves the JSON variant alone when there is no callbackURL', () => {
    const { ctx } = makeCtx({ returned: { twoFactorRedirect: true } });
    rewriteNavigationTwoFactorChallenge(ctx);
  });

  it('does nothing when the response is not a two-factor challenge', () => {
    const { ctx } = makeCtx({
      callbackURL: '/dashboard',
      returned: { token: 'sess' },
    });
    rewriteNavigationTwoFactorChallenge(ctx);
  });

  it('redirects a browser navigation to sign-in and keeps the two_factor cookie on the 302', () => {
    const { ctx } = makeCtx({ callbackURL: '/dashboard' });
    const error = expectRedirect(() => rewriteNavigationTwoFactorChallenge(ctx));
    const headers = headersOf(error);

    expect(headers.get('location')).toBe(
      `${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent('/dashboard')}`,
    );

    const cookies = headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.includes('two_factor='))).toBe(true);
    expect(cookies).toContain(TWO_FACTOR_COOKIE);
    expect(cookies).toContain(EXPIRED_SESSION_COOKIE);
  });

  it('sanitizes a hostile callbackURL instead of following it', () => {
    const { ctx } = makeCtx({ callbackURL: 'https://evil.com/phish' });
    const headers = headersOf(expectRedirect(() => rewriteNavigationTwoFactorChallenge(ctx)));
    expect(headers.get('location')).toBe(`${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent('/')}`);
    expect(headers.getSetCookie().some((cookie) => cookie.includes('two_factor='))).toBe(true);
  });
});
