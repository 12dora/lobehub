/**
 * Client-side mirror of `adminUsersSetPasswordInputSchema` bounds.
 *
 * The single source of the number is Better Auth's `minPasswordLength` in
 * `src/libs/better-auth/define-config.ts`, mirrored server-side as
 * `BOOTSTRAP_PASSWORD_MIN_LENGTH`. The client mirror already exists for the
 * create-user form — reuse it rather than introducing a third copy.
 */
import { PASSWORD_MAX, PASSWORD_MIN } from '../createUser/validation';

export { PASSWORD_MAX, PASSWORD_MIN };

export interface SetPasswordFormFields {
  confirmPassword: string;
  newPassword: string;
}

export interface SetPasswordFormValidation {
  /** Confirmation entered and differs from the new password. */
  confirmInvalid: boolean;
  /** Both fields satisfy the policy and match — the submit button may enable. */
  formValid: boolean;
  /** Something was typed but it is outside the policy bounds. */
  passwordInvalid: boolean;
}

/**
 * Invalid flags stay false while a field is untouched so the form does not shout
 * at an admin who has not typed yet — the persistent rule hint carries the policy.
 */
export const validateSetPasswordForm = ({
  confirmPassword,
  newPassword,
}: SetPasswordFormFields): SetPasswordFormValidation => {
  const lengthOk = newPassword.length >= PASSWORD_MIN && newPassword.length <= PASSWORD_MAX;
  const passwordInvalid = newPassword.length > 0 && !lengthOk;
  const confirmInvalid = confirmPassword.length > 0 && confirmPassword !== newPassword;

  return {
    confirmInvalid,
    formValid: lengthOk && confirmPassword.length > 0 && confirmPassword === newPassword,
    passwordInvalid,
  };
};
