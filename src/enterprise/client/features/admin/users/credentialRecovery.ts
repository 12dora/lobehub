/**
 * Copy resolution for the admin credential-recovery action (the one that clears a
 * user's second factors so they can get back in).
 *
 * The action covers three account shapes, and each needs its own words:
 *
 * - TOTP only            → "turn off two-step verification"
 * - TOTP **and** passkeys → the same, plus an opt-in to also drop the passkeys
 * - passkeys only        → purely "remove the passkeys"; naming two-step
 *   verification here would describe something the account never had
 *
 * The passkey-only shape is the ordinary state of a passkey user, and it is a real
 * lockout case: someone lost the device holding their only passkey. Gating the
 * action on `twoFactorEnabled` alone left an admin with nothing to offer them.
 */

/** Whether the credential-recovery action has anything to clear at all. */
export const hasRecoverableCredentials = (account: {
  passkeyCount: number;
  twoFactorEnabled: boolean;
}): boolean => account.twoFactorEnabled || account.passkeyCount > 0;

/**
 * Whether "also remove their passkeys" is a genuine second choice.
 *
 * With an authenticator in play it is: the passkeys are a separate loss of access,
 * so the admin opts in. Without one, removing the passkeys *is* the action — an
 * unchecked box would submit a no-op — so it is implied rather than offered.
 */
export const isPasskeyRemovalOptional = (account: {
  passkeyCount: number;
  twoFactorEnabled: boolean;
}): boolean => account.twoFactorEnabled && account.passkeyCount > 0;

/** The `removePasskeys` flag to submit, given the account shape and the opt-in box. */
export const resolveRemovePasskeys = (params: {
  optIn: boolean;
  passkeyCount: number;
  twoFactorEnabled: boolean;
}): boolean => {
  if (params.passkeyCount <= 0) return false;
  return isPasskeyRemovalOptional(params) ? params.optIn : true;
};

export type CredentialRecoveryVariant = 'twoFactor' | 'passkeyOnly';

export const resolveCredentialRecoveryVariant = (account: {
  twoFactorEnabled: boolean;
}): CredentialRecoveryVariant => (account.twoFactorEnabled ? 'twoFactor' : 'passkeyOnly');

/**
 * The passkey-only wording has no key in `admin.json` yet — the `users.security.*`
 * namespace only ever spoke about two-step verification. These four keys are
 * reported to the locale owner; `defaultValue` carries the English copy until they
 * land, so the modal never shows a raw key or the wrong factor's name.
 */
export const PASSKEY_ONLY_COPY_FALLBACKS = {
  action: 'Remove passkeys',
  desc: "This removes {{name}}'s passkeys ({{num}}). Confirm who you are talking to first — afterwards they sign in with their password alone.",
  submit: 'Remove passkeys',
  success: 'Passkeys removed',
  title: 'Remove passkeys?',
} as const;

export type CredentialRecoveryCopySlot = keyof typeof PASSKEY_ONLY_COPY_FALLBACKS;

/** i18n key + English fallback for one slot of the action's copy. */
export const resolveCredentialRecoveryCopy = (
  variant: CredentialRecoveryVariant,
  slot: CredentialRecoveryCopySlot,
): { defaultValue?: string; key: string } =>
  variant === 'twoFactor'
    ? { key: `users.security.twoFactor.${slot}` }
    : {
        defaultValue: PASSKEY_ONLY_COPY_FALLBACKS[slot],
        key: `users.security.passkey.${slot}`,
      };
