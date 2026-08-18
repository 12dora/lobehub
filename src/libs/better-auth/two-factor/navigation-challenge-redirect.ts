import { APIError } from 'better-auth/api';

import { appEnv } from '@/envs/app';
import { isSafeRedirectPath } from '@/utils/onboardingRedirect';

/**
 * Browser-navigation sign-in endpoints that the widened two-factor hook
 * challenges with JSON. When `callbackURL` is present they would have
 * `throw ctx.redirect(...)` — an after-hook JSON response overwrites that
 * and the user sees raw JSON in the tab. Rewrite those to a 302 instead.
 *
 * `/sign-in/email-otp` is a fetch, not a navigation — leave it as JSON.
 * OAuth callbacks stay exempt (policy + same redirect-overwrite problem).
 */
export const NAVIGATION_2FA_CHALLENGE_PATHS = new Set(['/magic-link/verify', '/verify-email']);

export const SIGN_IN_PATH = '/signin';

export interface NavigationChallengeContext {
  context: {
    responseHeaders?: Headers;
    returned?: unknown;
  };
  query?: { callbackURL?: string | string[] };
}

export const isTwoFactorChallengeBody = (returned: unknown): boolean => {
  if (!returned || typeof returned !== 'object') return false;
  const body =
    '_flag' in returned && (returned as { _flag?: unknown })._flag === 'json'
      ? (returned as { body?: unknown }).body
      : returned;
  return (
    !!body &&
    typeof body === 'object' &&
    (body as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
  );
};

/**
 * Same-origin callback only. Reuses `isSafeRedirectPath` (the repo's
 * open-redirect policy) and, for absolute URLs, APP_URL's origin — the
 * server equivalent of the client's `sanitizeRedirectPath` (which needs
 * `window.location.origin`).
 */
export const sanitizeServerCallbackUrl = (
  raw: string | null | undefined,
  fallback = '/',
): string => {
  if (!raw) return fallback;
  if (isSafeRedirectPath(raw)) return raw;

  try {
    const parsed = new URL(raw);
    const origin = appEnv.APP_URL ? new URL(appEnv.APP_URL).origin : '';
    if (origin && parsed.origin === origin) {
      const relative = parsed.pathname + parsed.search + parsed.hash;
      if (isSafeRedirectPath(relative)) return relative;
    }
  } catch {
    // fall through
  }

  return fallback;
};

export const buildSignInChallengeUrl = (callbackURL: string): string => {
  const params = new URLSearchParams({
    callbackUrl: sanitizeServerCallbackUrl(callbackURL),
  });
  return `${SIGN_IN_PATH}?${params.toString()}`;
};

/**
 * `createInternalContext` allocates a fresh Headers bag per after-hook, and
 * `ctx.redirect` writes Location onto *that* bag — so the `two_factor`
 * cookie the stock hook already merged onto `ctx.context.responseHeaders`
 * would be dropped. Build the 302 ourselves and copy those cookies on.
 */
export const copySetCookieHeaders = (from: Headers | undefined, to: Headers): void => {
  if (!from) return;
  const cookies = typeof from.getSetCookie === 'function' ? from.getSetCookie() : [];
  for (const cookie of cookies) {
    to.append('set-cookie', cookie);
  }
};

export const rewriteNavigationTwoFactorChallenge = (ctx: NavigationChallengeContext): void => {
  if (!isTwoFactorChallengeBody(ctx.context.returned)) return;

  const raw = ctx.query?.callbackURL;
  const callbackURL = Array.isArray(raw) ? raw[0] : raw;
  if (typeof callbackURL !== 'string' || callbackURL.length === 0) return;

  const headers = new Headers();
  copySetCookieHeaders(ctx.context.responseHeaders, headers);
  headers.set('location', buildSignInChallengeUrl(callbackURL));
  throw new APIError('FOUND', undefined, headers);
};
