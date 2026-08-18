/**
 * Better Auth is authoritative for these bounds — `emailAndPassword.minPasswordLength` /
 * `maxPasswordLength` in `src/libs/better-auth/define-config.ts`. They are mirrored here
 * (rather than imported) because `src/routes/**` may not import from `@/enterprise/**`,
 * where the other client-side mirror lives, and the server config itself is not
 * client-bundlable. If the server bounds move, this pair moves with them; the server stays
 * the last word, and anything it rejects surfaces through `mapChangePasswordError`.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

export interface ChangePasswordFormValues {
  confirmPassword: string;
  currentPassword: string;
  newPassword: string;
}

/** Field name → the i18n suffix under `profile.security.password.` that explains it. */
export interface ChangePasswordErrors {
  confirmPassword?: 'mismatch';
  currentPassword?: 'incorrect';
  newPassword?: 'rule' | 'reuse';
}

/**
 * True once every field carries something. Submission is gated on *completeness*, not on
 * validity: a button disabled by a rule the user cannot see reads as broken, so we let
 * them submit and pin the reason on the offending field instead.
 */
export const isChangePasswordComplete = ({
  confirmPassword,
  currentPassword,
  newPassword,
}: ChangePasswordFormValues): boolean =>
  currentPassword.length > 0 && newPassword.length > 0 && confirmPassword.length > 0;

/**
 * Client-side mirror of the checks Better Auth performs, so the common mistakes are
 * caught before a round-trip. The server stays authoritative — anything it rejects that
 * we let through comes back through `mapChangePasswordError`.
 *
 * The maximum length is enforced by the input's `maxLength` rather than here: there is no
 * copy for "too long", and showing the "at least N characters" rule for an over-long
 * password would be actively misleading.
 */
export const validateChangePassword = ({
  confirmPassword,
  currentPassword,
  newPassword,
}: ChangePasswordFormValues): ChangePasswordErrors => {
  const errors: ChangePasswordErrors = {};

  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    errors.newPassword = 'rule';
  } else if (currentPassword.length > 0 && newPassword === currentPassword) {
    // Better Auth accepts a no-op password change; we don't, because it silently gives the
    // user the impression their password has rotated when it has not.
    errors.newPassword = 'reuse';
  }

  if (confirmPassword !== newPassword) {
    errors.confirmPassword = 'mismatch';
  }

  return errors;
};

export const hasChangePasswordErrors = (errors: ChangePasswordErrors): boolean =>
  Object.keys(errors).length > 0;

interface ServerErrorLike {
  code?: string;
  message?: string;
}

/**
 * Map a Better Auth error onto the field that caused it, so the message lands next to the
 * input the user has to fix (the repo precedent is `useSignIn.ts`, which pins a wrong
 * password on the field rather than firing a toast).
 *
 * Returns `null` for anything not attributable to a field — those are network / server
 * failures and belong in a toast.
 */
export const mapChangePasswordError = (
  error: ServerErrorLike | null | undefined,
): ChangePasswordErrors | null => {
  if (!error) return null;

  switch (error.code) {
    case 'INVALID_PASSWORD': {
      return { currentPassword: 'incorrect' };
    }
    case 'PASSWORD_TOO_SHORT': {
      return { newPassword: 'rule' };
    }
    default: {
      return null;
    }
  }
};
