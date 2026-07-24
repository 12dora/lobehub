export const PLATFORM_SECRET_ROTATION_DOMAINS = [
  'aiCurrent',
  'aiImmutable',
  'connector',
  'identityProvider',
  'identityProviderTestPkce',
  'globalCredentialSecret',
  'globalCredentialUpload',
] as const;

export type PlatformSecretRotationDomain = (typeof PLATFORM_SECRET_ROTATION_DOMAINS)[number];

export interface PlatformSecretRotationCursor {
  domain: PlatformSecretRotationDomain;
  id: string;
}

/**
 * Internal-only rotation material. Implementations keep these values
 * non-enumerable so generic JSON/inspection paths cannot serialize ciphertext.
 */
export interface PlatformSecretRotationCandidate {
  readonly ciphertext: string;
  readonly domain: PlatformSecretRotationDomain;
  readonly fingerprint: string | null;
  readonly id: string;
  readonly ownerId: string | null;
  readonly revision: number | null;
  readonly storedKeyId: string | null;
}

export interface PlatformSecretRotationPage {
  items: PlatformSecretRotationCandidate[];
  nextCursor: PlatformSecretRotationCursor | null;
}

export interface PlatformSecretRotationCasResult {
  /** AI immutable only: matching current material was synchronized transactionally. */
  currentSynchronized: boolean;
  /** False means the exact old row no longer exists and no write was performed. */
  updated: boolean;
}
