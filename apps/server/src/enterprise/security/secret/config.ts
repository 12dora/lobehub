/**
 * Platform Secret module config.
 *
 * Intentionally NOT wired through packages/env — keeps credentials isolated
 * to this security module (M13). Never serialize or log the returned values.
 */

/** Env var name for the platform master key (KEK material, base64 32 bytes). */
export const PLATFORM_MASTER_KEY_ENV = 'PLATFORM_MASTER_KEY';

/** Optional key id override for EnvKeyProvider (default: env:default). */
export const PLATFORM_MASTER_KEY_ID_ENV = 'PLATFORM_MASTER_KEY_ID';

/** Explicit provider selector. Omitted keeps the legacy EnvKeyProvider path. */
export const PLATFORM_KEY_PROVIDER_ENV = 'PLATFORM_KEY_PROVIDER';

export const VAULT_ADDR_ENV = 'VAULT_ADDR';
export const VAULT_TOKEN_ENV = 'VAULT_TOKEN';
export const VAULT_APPROLE_ROLE_ID_ENV = 'VAULT_APPROLE_ROLE_ID';
export const VAULT_APPROLE_SECRET_ID_ENV = 'VAULT_APPROLE_SECRET_ID';
export const VAULT_APPROLE_MOUNT_PATH_ENV = 'VAULT_APPROLE_MOUNT_PATH';
export const VAULT_KV_MOUNT_PATH_ENV = 'VAULT_KV_MOUNT_PATH';
export const VAULT_KV_SECRET_PATH_ENV = 'VAULT_KV_SECRET_PATH';

export const DEFAULT_ENV_KEY_ID = 'env:default';

/** Cipher envelope algorithm identifier (AES-256-GCM). */
export const ENVELOPE_ALG = 'A256GCM' as const;

/** Current envelope format version. */
export const ENVELOPE_VERSION = 1 as const;

/** Prefix for self-describing ciphertext strings. */
export const CIPHERTEXT_PREFIX = 'aihub.secret';

export type PlatformSecretEnv = Record<string, string | undefined>;

export type PlatformKeyProviderName = 'env' | 'vault';

export interface PlatformSecretModuleConfig {
  /** Present only when PLATFORM_MASTER_KEY is set and valid base64. */
  masterKeyBase64: string | undefined;
  masterKeyId: string;
}

/**
 * Parse secret-module config from an env bag (defaults to process.env).
 * Does not throw on missing key — callers decide fail-closed vs optional.
 */
export const parsePlatformSecretConfig = (
  env: PlatformSecretEnv = process.env,
): PlatformSecretModuleConfig => ({
  masterKeyBase64: env[PLATFORM_MASTER_KEY_ENV]?.trim() || undefined,
  masterKeyId: env[PLATFORM_MASTER_KEY_ID_ENV]?.trim() || DEFAULT_ENV_KEY_ID,
});

export const parsePlatformKeyProviderName = (
  env: PlatformSecretEnv = process.env,
): PlatformKeyProviderName => {
  const value = env[PLATFORM_KEY_PROVIDER_ENV]?.trim().toLowerCase();
  if (!value || value === 'env') return 'env';
  if (value === 'vault') return 'vault';
  throw new Error(`${PLATFORM_KEY_PROVIDER_ENV} must be either env or vault`);
};
