// Client-side mirrors of `adminUsersCreateInputSchema` bounds (server remains authoritative).
export const EMAIL_MAX = 255;
export const FULL_NAME_MAX = 100;
export const USERNAME_MAX = 64;
export const USERNAME_PATTERN = /^[\w.-]+$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;
/**
 * Mirror of zod v3's `.email()` regex (server schema uses zod): ASCII local part, no
 * leading dot / consecutive dots, dotted domain with 2+ letter TLD. A looser client
 * pattern would let inputs through that the server rejects as BAD_REQUEST.
 */
export const EMAIL_PATTERN =
  /^(?!\.)(?!.+\.\.)[\w'+\-.]*[\w+-]@(?:[A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

export interface CreateUserFormFields {
  email: string;
  fullName: string;
  password: string;
  username: string;
}

export interface CreateUserFormValidation {
  emailInvalid: boolean;
  formValid: boolean;
  fullNameInvalid: boolean;
  passwordInvalid: boolean;
  trimmedEmail: string;
  trimmedFullName: string;
  trimmedUsername: string;
  usernameInvalid: boolean;
}

export const validateCreateUserForm = ({
  email,
  fullName,
  password,
  username,
}: CreateUserFormFields): CreateUserFormValidation => {
  const trimmedEmail = email.trim().toLowerCase();
  const trimmedFullName = fullName.trim();
  const trimmedUsername = username.trim();

  const emailInvalid =
    trimmedEmail.length > 0 &&
    (trimmedEmail.length > EMAIL_MAX || !EMAIL_PATTERN.test(trimmedEmail));
  const fullNameInvalid = trimmedFullName.length > FULL_NAME_MAX;
  const usernameInvalid =
    trimmedUsername.length > 0 &&
    (trimmedUsername.length > USERNAME_MAX || !USERNAME_PATTERN.test(trimmedUsername));
  const passwordInvalid =
    password.length > 0 && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX);

  const formValid =
    trimmedEmail.length > 0 &&
    !emailInvalid &&
    trimmedFullName.length > 0 &&
    !fullNameInvalid &&
    !usernameInvalid &&
    password.length >= PASSWORD_MIN &&
    password.length <= PASSWORD_MAX;

  return {
    emailInvalid,
    formValid,
    fullNameInvalid,
    passwordInvalid,
    trimmedEmail,
    trimmedFullName,
    trimmedUsername,
    usernameInvalid,
  };
};
