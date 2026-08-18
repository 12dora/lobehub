/**
 * Better Auth answers with a machine code plus an English sentence written for developers
 * (`OTP not enabled`, `Session is not fresh`, …). Rendering `error.message` puts that
 * sentence — or worse, a raw code — in front of a user whose UI is in another language, so
 * every surface in this slice resolves the code to copy we own and falls back to a generic
 * message when the code is one we have nothing better to say about.
 *
 * Codes come from Better Auth's own tables: `BASE_ERROR_CODES` (better-auth), the
 * `TWO_FACTOR_ERROR_CODES` of the two-factor plugin and `PASSKEY_ERROR_CODES` of
 * `@better-auth/passkey`. Anything absent here is deliberate — either it cannot reach these
 * screens, or the honest answer is the generic fallback rather than a guess.
 */

/** The shape both `better-fetch` errors and thrown API errors share. */
export interface AuthErrorLike {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}

/** HTTP status the rate limiter answers with; it carries no error code of its own. */
const TOO_MANY_REQUESTS = 429;

const MESSAGE_KEY_BY_CODE = {
  AUTH_CANCELLED: 'profile.security.passkey.cancelled',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'profile.security.error.noPasswordAccount',
  INVALID_BACKUP_CODE: 'profile.security.twoFactor.totp.invalidCode',
  INVALID_CODE: 'profile.security.twoFactor.totp.invalidCode',
  INVALID_EMAIL: 'profile.emailInvalid',
  INVALID_PASSWORD: 'profile.security.password.incorrect',
  INVALID_TWO_FACTOR_COOKIE: 'profile.security.error.sessionExpired',
  OTP_HAS_EXPIRED: 'profile.security.twoFactor.totp.invalidCode',
  OTP_NOT_ENABLED: 'profile.security.twoFactor.totp.disabled',
  PASSKEY_NOT_FOUND: 'profile.security.error.passkeyNotFound',
  PASSWORD_TOO_LONG: 'profile.security.error.passwordTooLong',
  PASSWORD_TOO_SHORT: 'profile.security.error.passwordTooShort',
  PREVIOUSLY_REGISTERED: 'profile.security.error.passkeyAlreadyRegistered',
  REGISTRATION_CANCELLED: 'profile.security.passkey.cancelled',
  SESSION_EXPIRED: 'profile.security.error.sessionExpired',
  SESSION_NOT_FRESH: 'profile.security.error.reauthRequired',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'profile.security.error.tooManyAttempts',
  TOTP_NOT_ENABLED: 'profile.security.twoFactor.totp.disabled',
  TWO_FACTOR_NOT_ENABLED: 'profile.security.twoFactor.totp.disabled',
} as const;

const TOO_MANY_REQUESTS_KEY = 'profile.security.error.tooManyRequests';

/**
 * A literal union rather than `string`: `t()` is typed against the resource keys, so a key
 * that stops existing is a compile error instead of a raw key rendered to the user.
 */
export type AuthErrorMessageKey =
  (typeof MESSAGE_KEY_BY_CODE)[keyof typeof MESSAGE_KEY_BY_CODE] | typeof TOO_MANY_REQUESTS_KEY;

/**
 * The key in the `auth` namespace that explains `error`, or `null` when the code is not one
 * we recognise — the caller then picks its own fallback, because "could not send the link"
 * and "unknown error" are the right generic answers on different screens.
 *
 * Never returns `error.message`: an untranslated developer sentence is exactly what this
 * exists to keep out of the UI.
 */
export const authErrorMessageKey = (
  error: AuthErrorLike | null | undefined,
): AuthErrorMessageKey | null => {
  if (!error) return null;
  const mapped = error.code
    ? (MESSAGE_KEY_BY_CODE as Record<string, AuthErrorMessageKey | undefined>)[error.code]
    : undefined;
  if (mapped) return mapped;
  if (error.status === TOO_MANY_REQUESTS) return TOO_MANY_REQUESTS_KEY;
  return null;
};
