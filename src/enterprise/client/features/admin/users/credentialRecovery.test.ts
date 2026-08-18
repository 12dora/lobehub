import { describe, expect, it } from 'vitest';

import {
  hasRecoverableCredentials,
  isPasskeyRemovalOptional,
  resolveCredentialRecoveryCopy,
  resolveCredentialRecoveryVariant,
  resolveRemovePasskeys,
} from './credentialRecovery';

describe('hasRecoverableCredentials', () => {
  it('is false for an account with neither factor', () => {
    expect(hasRecoverableCredentials({ passkeyCount: 0, twoFactorEnabled: false })).toBe(false);
  });

  it('is true with an authenticator', () => {
    expect(hasRecoverableCredentials({ passkeyCount: 0, twoFactorEnabled: true })).toBe(true);
  });

  // The gap this fixes: an admin had no action for a passkey-only user who lost
  // the device holding their only passkey.
  it('is true for passkeys alone', () => {
    expect(hasRecoverableCredentials({ passkeyCount: 1, twoFactorEnabled: false })).toBe(true);
  });

  it('is true when both are present', () => {
    expect(hasRecoverableCredentials({ passkeyCount: 2, twoFactorEnabled: true })).toBe(true);
  });
});

describe('isPasskeyRemovalOptional / resolveRemovePasskeys', () => {
  it('offers the opt-in only when an authenticator is also being cleared', () => {
    expect(isPasskeyRemovalOptional({ passkeyCount: 2, twoFactorEnabled: true })).toBe(true);
    expect(isPasskeyRemovalOptional({ passkeyCount: 2, twoFactorEnabled: false })).toBe(false);
    expect(isPasskeyRemovalOptional({ passkeyCount: 0, twoFactorEnabled: true })).toBe(false);
  });

  it('honours the opt-in when both factors are present', () => {
    const account = { passkeyCount: 2, twoFactorEnabled: true };
    expect(resolveRemovePasskeys({ ...account, optIn: false })).toBe(false);
    expect(resolveRemovePasskeys({ ...account, optIn: true })).toBe(true);
  });

  // Without an authenticator, removing the passkeys is the whole action — an
  // unchecked box would submit a modal that does nothing.
  it('always removes for a passkey-only account, whatever the box says', () => {
    const account = { passkeyCount: 1, twoFactorEnabled: false };
    expect(resolveRemovePasskeys({ ...account, optIn: false })).toBe(true);
    expect(resolveRemovePasskeys({ ...account, optIn: true })).toBe(true);
  });

  it('never claims to remove passkeys the account does not have', () => {
    expect(resolveRemovePasskeys({ optIn: true, passkeyCount: 0, twoFactorEnabled: true })).toBe(
      false,
    );
  });
});

describe('resolveCredentialRecoveryVariant', () => {
  it('speaks about two-step verification whenever an authenticator exists', () => {
    expect(resolveCredentialRecoveryVariant({ twoFactorEnabled: true })).toBe('twoFactor');
  });

  it('drops all 2FA language when the account has no authenticator', () => {
    expect(resolveCredentialRecoveryVariant({ twoFactorEnabled: false })).toBe('passkeyOnly');
  });
});

describe('resolveCredentialRecoveryCopy', () => {
  it('uses the shipped two-factor keys with no fallback copy', () => {
    for (const slot of ['action', 'desc', 'submit', 'success', 'title'] as const) {
      const copy = resolveCredentialRecoveryCopy('twoFactor', slot);
      expect(copy.key).toBe(`users.security.twoFactor.${slot}`);
      expect(copy.defaultValue).toBeUndefined();
    }
  });

  // These keys are not in admin.json yet, so every passkey-only slot must carry a
  // fallback — otherwise the modal would render a raw i18n key.
  it('carries an English fallback for every passkey-only slot', () => {
    for (const slot of ['action', 'desc', 'submit', 'success', 'title'] as const) {
      const copy = resolveCredentialRecoveryCopy('passkeyOnly', slot);
      expect(copy.key).toBe(`users.security.passkey.${slot}`);
      expect(copy.defaultValue).toBeTruthy();
      expect(copy.defaultValue).not.toMatch(/two-step|two-factor/i);
    }
  });
});
