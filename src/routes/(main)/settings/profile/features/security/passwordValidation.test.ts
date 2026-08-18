import { describe, expect, it } from 'vitest';

import {
  type ChangePasswordFormValues,
  hasChangePasswordErrors,
  isChangePasswordComplete,
  mapChangePasswordError,
  PASSWORD_MIN_LENGTH,
  validateChangePassword,
} from './passwordValidation';

const values = (overrides: Partial<ChangePasswordFormValues> = {}): ChangePasswordFormValues => ({
  confirmPassword: 'brand-new-password',
  currentPassword: 'old-password',
  newPassword: 'brand-new-password',
  ...overrides,
});

describe('isChangePasswordComplete', () => {
  it('is true only when all three fields carry something', () => {
    expect(isChangePasswordComplete(values())).toBe(true);
  });

  it.each([['confirmPassword'], ['currentPassword'], ['newPassword']] as const)(
    'is false when %s is empty',
    (field) => {
      expect(isChangePasswordComplete(values({ [field]: '' }))).toBe(false);
    },
  );
});

describe('validateChangePassword', () => {
  it('accepts a well-formed change', () => {
    expect(validateChangePassword(values())).toEqual({});
    expect(hasChangePasswordErrors(validateChangePassword(values()))).toBe(false);
  });

  it('flags a new password shorter than the minimum', () => {
    const short = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);

    expect(validateChangePassword(values({ confirmPassword: short, newPassword: short }))).toEqual({
      newPassword: 'rule',
    });
  });

  it('accepts a new password exactly at the minimum', () => {
    const exact = 'a'.repeat(PASSWORD_MIN_LENGTH);

    expect(validateChangePassword(values({ confirmPassword: exact, newPassword: exact }))).toEqual(
      {},
    );
  });

  it('flags reuse of the current password', () => {
    expect(
      validateChangePassword(
        values({
          confirmPassword: 'old-password',
          currentPassword: 'old-password',
          newPassword: 'old-password',
        }),
      ),
    ).toEqual({ newPassword: 'reuse' });
  });

  it('reports the length rule before reuse when both apply', () => {
    const short = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);

    expect(
      validateChangePassword({
        confirmPassword: short,
        currentPassword: short,
        newPassword: short,
      }),
    ).toEqual({ newPassword: 'rule' });
  });

  it('does not flag reuse while the current password is still empty', () => {
    const errors = validateChangePassword(values({ currentPassword: '' }));

    expect(errors.newPassword).toBeUndefined();
  });

  it('flags a confirmation that does not match', () => {
    expect(validateChangePassword(values({ confirmPassword: 'something-else' }))).toEqual({
      confirmPassword: 'mismatch',
    });
  });

  it('reports both fields when the new password is short and unconfirmed', () => {
    expect(
      validateChangePassword(values({ confirmPassword: 'nope', newPassword: 'short' })),
    ).toEqual({ confirmPassword: 'mismatch', newPassword: 'rule' });
  });
});

describe('mapChangePasswordError', () => {
  it('pins a wrong current password on the current-password field', () => {
    expect(mapChangePasswordError({ code: 'INVALID_PASSWORD' })).toEqual({
      currentPassword: 'incorrect',
    });
  });

  it('pins a server length rejection on the new-password field', () => {
    expect(mapChangePasswordError({ code: 'PASSWORD_TOO_SHORT' })).toEqual({
      newPassword: 'rule',
    });
  });

  it.each([
    ['an unrelated code', { code: 'INTERNAL_SERVER_ERROR' }],
    ['a code-less error', { message: 'Failed to fetch' }],
    ['null', null],
    ['undefined', undefined],
  ])('returns null for %s so the caller can toast it', (_label, error) => {
    expect(mapChangePasswordError(error)).toBeNull();
  });
});
