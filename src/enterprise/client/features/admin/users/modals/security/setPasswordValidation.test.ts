import { describe, expect, it } from 'vitest';

import { PASSWORD_MAX, PASSWORD_MIN, validateSetPasswordForm } from './setPasswordValidation';

describe('validateSetPasswordForm', () => {
  it('mirrors the Better Auth credential policy bounds', () => {
    // Single source: better-auth `minPasswordLength` → BOOTSTRAP_PASSWORD_MIN_LENGTH.
    expect(PASSWORD_MIN).toBe(8);
    expect(PASSWORD_MAX).toBe(64);
  });

  it('stays quiet while both fields are untouched', () => {
    expect(validateSetPasswordForm({ confirmPassword: '', newPassword: '' })).toEqual({
      confirmInvalid: false,
      formValid: false,
      passwordInvalid: false,
    });
  });

  it('flags a too-short password but not an empty confirmation', () => {
    const result = validateSetPasswordForm({ confirmPassword: '', newPassword: 'short' });
    expect(result.passwordInvalid).toBe(true);
    expect(result.confirmInvalid).toBe(false);
    expect(result.formValid).toBe(false);
  });

  it('flags a password past the maximum', () => {
    const result = validateSetPasswordForm({
      confirmPassword: 'a'.repeat(PASSWORD_MAX + 1),
      newPassword: 'a'.repeat(PASSWORD_MAX + 1),
    });
    expect(result.passwordInvalid).toBe(true);
    expect(result.formValid).toBe(false);
  });

  it('flags a mismatched confirmation', () => {
    const result = validateSetPasswordForm({
      confirmPassword: 'correct-horse-x',
      newPassword: 'correct-horse',
    });
    expect(result.confirmInvalid).toBe(true);
    expect(result.formValid).toBe(false);
  });

  it('is valid only when a policy-compliant password is confirmed', () => {
    expect(
      validateSetPasswordForm({ confirmPassword: 'correct-horse', newPassword: 'correct-horse' }),
    ).toEqual({ confirmInvalid: false, formValid: true, passwordInvalid: false });
  });

  it('is invalid when only the new password is filled in', () => {
    expect(
      validateSetPasswordForm({ confirmPassword: '', newPassword: 'correct-horse' }).formValid,
    ).toBe(false);
  });
});
