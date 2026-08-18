import { describe, expect, it } from 'vitest';

import { authErrorMessageKey } from './authErrorMessage';

describe('authErrorMessageKey', () => {
  it('resolves a known code to copy we own', () => {
    expect(authErrorMessageKey({ code: 'INVALID_PASSWORD' })).toBe(
      'profile.security.password.incorrect',
    );
    expect(authErrorMessageKey({ code: 'SESSION_EXPIRED' })).toBe(
      'profile.security.error.sessionExpired',
    );
    expect(authErrorMessageKey({ code: 'OTP_HAS_EXPIRED' })).toBe(
      'profile.security.twoFactor.totp.invalidCode',
    );
  });

  it('resolves the rate limiter, which answers with a status and no code', () => {
    expect(authErrorMessageKey({ message: 'Too many requests.', status: 429 })).toBe(
      'profile.security.error.tooManyRequests',
    );
  });

  it('prefers the code over the status when both are present', () => {
    expect(authErrorMessageKey({ code: 'INVALID_CODE', status: 429 })).toBe(
      'profile.security.twoFactor.totp.invalidCode',
    );
  });

  it('returns null rather than a guess for anything unmapped', () => {
    expect(authErrorMessageKey({ code: 'FAILED_TO_CREATE_USER', status: 500 })).toBeNull();
    expect(authErrorMessageKey({ message: 'Internal server error', status: 500 })).toBeNull();
    expect(authErrorMessageKey(null)).toBeNull();
    expect(authErrorMessageKey(undefined)).toBeNull();
  });

  it('never hands back the server message or the raw code', () => {
    const message = 'Session is not fresh';
    const key = authErrorMessageKey({ code: 'SESSION_NOT_FRESH', message, status: 403 });

    expect(key).not.toBe(message);
    expect(key).not.toBe('SESSION_NOT_FRESH');
    expect(key).toMatch(/^profile\./);
  });
});
