import { getCurrentAuthContext } from '@better-auth/core/context';
import { APIError } from 'better-auth/api';

import {
  clearOrphanedTwoFactorEnabled,
  getTwoFactorEnrollmentState,
  isStaleTwoFactorOrphan,
} from '@/database/models/twoFactor';
import type { LobeChatDatabase } from '@/database/type';

import { EXTRA_2FA_CHALLENGE_PATHS } from './with-challenged-paths';

export const TWO_FACTOR_VERIFICATION_PATHS = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
]);

export const isTwoFactorVerificationPath = (path: string | null | undefined): boolean =>
  typeof path === 'string' && TWO_FACTOR_VERIFICATION_PATHS.has(path);

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
 * `/change-password` rotates a session for an already-authenticated principal.
 * `/admin/impersonate-user` is NOT here: it mints a TOTP user's session with
 * no challenge. Platform admin blocks the route when enabled; when it is off
 * the built-in better-auth admin must not be a 2FA bypass.
 */
export const TWO_FACTOR_SESSION_ALLOWED_PATHS = new Set([
  ...TWO_FACTOR_VERIFICATION_PATHS,
  '/passkey/verify-authentication',
  '/sign-in/email',
  '/sign-in/username',
  '/sign-in/phone-number',
  ...EXTRA_2FA_CHALLENGE_PATHS,
  '/change-password',
]);

/** better-auth social (`/callback/:id`) and generic-OAuth (`/oauth2/callback/:id`). */
export const isOAuthCallbackPath = (path: string): boolean =>
  path.startsWith('/callback/') || path.startsWith('/oauth2/callback/');

export const TWO_FACTOR_REQUIRED_CODE = 'TWO_FACTOR_REQUIRED';

export const TWO_FACTOR_REQUIRED_MESSAGE =
  'This account has two-step verification enabled. Sign in with your password to complete two-step verification.';

type AuthPathContext = { path?: string | null };

export const isTwoFactorSessionPathAllowed = (path: string | null | undefined): boolean => {
  // `null` / `undefined` = no HTTP request (bootstrap, scripts, tests). Those
  // callers already hold whatever privilege they need to mint a session.
  // An empty string is a request that failed to name a route — fail closed.
  if (path === null || path === undefined) return true;
  if (path.length === 0) return false;
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

  // Preserve empty-string so the gate can fail closed; only a missing
  // context becomes null (scripted / bootstrap create).
  if (typeof path === 'string') return path;
  return null;
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
 * so a half-finished enrolment cannot lock the user out — but NEVER during
 * `/two-factor/verify-*`, where that pair is the in-flight enable transition
 * (flag flipped, session rotated, *then* the row marked verified).
 */
export const enforceTwoFactorSessionGate = async (params: {
  context?: AuthPathContext | null;
  db: LobeChatDatabase;
  userId: string;
}): Promise<void> => {
  const path = await resolveAuthRequestPath(params.context);
  const state = await getTwoFactorEnrollmentState(params.db, params.userId);

  if (
    state.enabled &&
    !state.hasVerifiedFactor &&
    !isTwoFactorVerificationPath(path) &&
    isStaleTwoFactorOrphan(state)
  ) {
    await clearOrphanedTwoFactorEnabled(params.db, params.userId);
    return;
  }

  if (!state.enabled) return;

  if (isTwoFactorSessionPathAllowed(path)) return;

  rejectTwoFactorSessionBypass();
};
