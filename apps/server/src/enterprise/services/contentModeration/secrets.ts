import { createHash } from 'node:crypto';

import { PlatformSecretService } from '@/server/enterprise/security/secret';

/** Encrypt a Moderations API key. The returned string is an opaque ciphertext ref. */
export const encryptModerationApiKey = async (
  secretService: PlatformSecretService,
  plaintext: string,
): Promise<string> => secretService.encrypt(plaintext);

/** Decrypt an opaque ciphertext ref back to the API key plaintext. */
export const decryptModerationApiKey = async (
  secretService: PlatformSecretService,
  ref: string,
): Promise<string> => secretService.decrypt(ref);

/** First 16 hex chars of sha256(plaintext). Safe to persist / echo. */
export const fingerprintModerationApiKey = (plaintext: string): string =>
  createHash('sha256').update(plaintext).digest('hex').slice(0, 16);

/**
 * Mask a key as `sk-…ab12` (or `••••ab12`). Keys of 8 characters or fewer are
 * fully masked so a short secret is never echoed back.
 */
export const maskModerationApiKey = (plaintext: string): string => {
  if (plaintext.length <= 8) return plaintext.startsWith('sk-') ? 'sk-…' : '••••';
  const last4 = plaintext.slice(-4);
  if (plaintext.startsWith('sk-')) return `sk-…${last4}`;
  return `••••${last4}`;
};

/**
 * How B3 routers obtain {@link PlatformSecretService}:
 *
 * ```
 * import { PlatformSecretService } from '@/server/enterprise/security/secret';
 * const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
 * ```
 *
 * Same factory as `aiCatalogSupport.ts` / `identityProvidersSupport.ts`.
 */
export const obtainPlatformSecretService = (): PlatformSecretService | null =>
  PlatformSecretService.fromEnvOrThrowIfEnterprise();
