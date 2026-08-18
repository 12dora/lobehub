import { getCurrentAuthContext } from '@better-auth/core/context';
import { APIError } from 'better-auth/api';

import {
  clearOrphanedTwoFactorEnabled,
  getTwoFactorEnrollmentState,
} from '@/database/models/twoFactor';
import type { LobeChatDatabase } from '@/database/type';

import { EXTRA_2FA_CHALLENGE_PATHS } from './with-challenged-paths';

/**
 * HTTP paths that may mint a session for a user with `twoFactorEnabled`.
 *
 * This gate is defence-in-depth: it must ALLOW every path the two-factor
 * after-hook challenges, because `session.create.before` runs first. Denying
 * magic-link / email-OTP here would kill the request before the widened
 * matcher can convert the session into `{ twoFactorRedirect: true }`.
 *
 * `/sign-in/email` (and username / phone-number) create a session first; the
 * stock after-hook then deletes it. Same create-then-challenge reason applies
 * to `EXTRA_2FA_CHALLENGE_PATHS`.
 *
 * `/passkey/verify-authentication` is a deliberate exception: a passkey with
 * user verification is already a strong factor, so it may skip TOTP.
 *
 * OAuth / OIDC prefixes are exempt by policy (MFA delegated to the IdP) and
 * are matched separately — they are not challenged, because a redirect
 * response cannot carry `twoFactorRedirect`.
 *
 * `/change-password` and `/admin/impersonate-user` rotate a session for an
 * already-authenticated principal (or an admin). They are not sign-in bypasses.
 */
export const TWO_FACTOR_SESSION_ALLOWED_PATHS = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
  '/passkey/verify-authentication',
  '/sign-in/email',
  '/sign-in/username',
  '/sign-in/phone-number',
  ...EXTRA_2FA_CHALLENGE_PATHS,
  '/change-password',
  '/admin/impersonate-user',
]);

/** better-auth social (`/callback/:id`) and generic-OAuth (`/oauth2/callback/:id`). */
export const isOAuthCallbackPath = (path: string): boolean =>
  path.startsWith('/callback/') || path.startsWith('/oauth2/callback/');

export const TWO_FACTOR_REQUIRED_CODE = 'TWO_FACTOR_REQUIRED';

export const TWO_FACTOR_REQUIRED_MESSAGE =
  'This account has two-step verification enabled. Sign in with your password to complete two-step verification.';

type AuthPathContext = { path?: string | null };

export const isTwoFactorSessionPathAllowed = (path: string | null | undefined): boolean => {
  if (typeof path !== 'string' || path.length === 0) return true;
  if (TWO_FACTOR_SESSION_ALLOWED_PATHS.has(path)) return true;
  return isOAuthCallbackPath(path);
};

export const resolveAuthRequestPath = async (
  context?: AuthPathContext | null,
): Promise<string | null> => {
  let path = context?.path;
  if (!path) {
    try {
      path = (await getCurrentAuthContext()).path;
    } catch {
      // No request context → scripted / admin / bootstrap create.
      return null;
    }
  }

  return typeof path === 'string' && path.length > 0 ? path : null;
};

export const rejectTwoFactorSessionBypass = (): never => {
  throw new APIError('FORBIDDEN', {
    code: TWO_FACTOR_REQUIRED_CODE,
    message: TWO_FACTOR_REQUIRED_MESSAGE,
  });
};

/**
 * Fail-closed session-create gate for TOTP-enabled accounts.
 *
 * Runs here (not on individual sign-in routes) because this is the same seam
 * IdP group→role enforcement uses: returning/throwing aborts the row before
 * a cookie is issued. A create with no HTTP path is left alone so admin
 * provisioning and tests keep working.
 *
 * Orphaned `twoFactorEnabled` (flag set, no verified factor) is repaired
 * first so a half-finished enrolment cannot lock the user out of every path.
 */
export const enforceTwoFactorSessionGate = async (params: {
  context?: AuthPathContext | null;
  db: LobeChatDatabase;
  userId: string;
}): Promise<void> => {
  const state = await getTwoFactorEnrollmentState(params.db, params.userId);

  if (state.enabled && !state.hasVerifiedFactor) {
    await clearOrphanedTwoFactorEnabled(params.db, params.userId);
    return;
  }

  if (!state.enabled) return;

  const path = await resolveAuthRequestPath(params.context);
  if (isTwoFactorSessionPathAllowed(path)) return;

  rejectTwoFactorSessionBypass();
};
