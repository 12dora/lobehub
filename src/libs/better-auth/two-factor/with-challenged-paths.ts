import { createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth/types';

import {
  NAVIGATION_2FA_CHALLENGE_PATHS,
  rewriteNavigationTwoFactorChallenge,
} from './navigation-challenge-redirect';
import { stripTrustDeviceHook } from './strip-trust-device';

/**
 * Sign-in endpoints that create a session via `setSessionCookie` (so
 * `ctx.context.newSession` is set) but are missing from better-auth's stock
 * two-factor matcher (`/sign-in/email|username|phone-number` only).
 *
 * The stock after-hook does not reject the sign-in — it converts the new
 * session into a pending challenge (delete cookie + row, write `2fa-*`
 * verification, set the signed `two_factor` cookie, return
 * `{ twoFactorRedirect: true }`). Widening the matcher reuses that handler
 * unchanged.
 *
 * OAuth / OIDC / DingTalk callbacks (`/callback/:id`, `/oauth2/callback/:id`)
 * are deliberately NOT here. They answer with a redirect, so
 * `ctx.json({ twoFactorRedirect })` has nowhere to land. SSO is exempt by
 * policy: MFA is delegated to the enterprise IdP.
 */
export const EXTRA_2FA_CHALLENGE_PATHS = new Set([
  '/magic-link/verify',
  '/sign-in/email-otp',
  // `/verify-email` auto-sign-in (`autoSignInAfterVerification`) also goes
  // through `setSessionCookie` (`email-verification.mjs` ~274). Same JSON
  // response shape as magic-link when there is no callback redirect; when
  // there is one, after-hooks still run and can replace the response.
  '/verify-email',
  // Mobile email-verification auto-sign-in. Same `setSessionCookie` + JSON
  // contract (`email-otp/routes.mjs` ~324). A fetch, so no navigation rewrite.
  '/email-otp/verify-email',
]);

/**
 * Widen the two-factor plugin's after-hook matcher. Do not copy the handler
 * body and do not re-derive the `"two_factor"` cookie name — both live inside
 * better-auth. If `hooks.after`'s shape changes, the matcher test fails.
 */
export const withTwoFactorChallengedPaths = <T extends BetterAuthPlugin>(plugin: T): T => {
  const after = plugin.hooks?.after;
  if (!Array.isArray(after)) return plugin;

  return {
    ...plugin,
    hooks: {
      ...plugin.hooks,
      before: [
        ...((plugin.hooks as { before?: (typeof stripTrustDeviceHook)[] } | undefined)?.before ??
          []),
        stripTrustDeviceHook,
      ],
      after: [
        ...after.map((hook) => ({
          ...hook,
          matcher: (ctx: { path?: string }) =>
            hook.matcher(ctx as never) ||
            (typeof ctx.path === 'string' && EXTRA_2FA_CHALLENGE_PATHS.has(ctx.path)),
        })),
        // Must run *after* the stock two-factor hook so `returned` is the
        // challenge JSON and `context.responseHeaders` already has the
        // `two_factor` cookie. Rewrites browser-navigation variants to a 302.
        {
          handler: createAuthMiddleware(async (ctx) => {
            rewriteNavigationTwoFactorChallenge({
              context: ctx.context,
              query: ctx.query as { callbackURL?: string } | undefined,
            });
          }),
          matcher: (ctx: { path?: string }) =>
            typeof ctx.path === 'string' && NAVIGATION_2FA_CHALLENGE_PATHS.has(ctx.path),
        },
      ],
    },
  } as T;
};
