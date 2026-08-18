import { APIError } from 'better-auth/api';

export const PASSKEY_USER_VERIFICATION_REQUIRED_CODE = 'PASSKEY_USER_VERIFICATION_REQUIRED';

export const PASSKEY_USER_VERIFICATION_REQUIRED_MESSAGE =
  'This passkey did not confirm user verification. Use a passkey with a PIN or biometric, or sign in with your password.';

/**
 * Passkeys are allowed to skip TOTP only because they prove possession *and*
 * a PIN/biometric. `@better-auth/passkey` requests `userVerification: "preferred"`
 * and verifies with `requireUserVerification: false`, so a presence-only
 * roaming authenticator would otherwise satisfy the ceremony with a touch.
 *
 * Reject any assertion whose UV flag is not set. The plugin has no option to
 * change the authentication-options `userVerification` string; registration
 * still requests `required` via `authenticatorSelection`.
 */
export const assertPasskeyUserVerified = (verification: {
  authenticationInfo?: { userVerified?: boolean } | null;
}): void => {
  if (verification.authenticationInfo?.userVerified === true) return;

  throw new APIError('UNAUTHORIZED', {
    code: PASSKEY_USER_VERIFICATION_REQUIRED_CODE,
    message: PASSKEY_USER_VERIFICATION_REQUIRED_MESSAGE,
  });
};
