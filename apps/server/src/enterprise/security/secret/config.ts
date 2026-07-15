/**
 * Platform Secret module config (env-local).
 *
 * Intentionally NOT wired through packages/env — keeps master-key surface
 * isolated to this security module (M13). Do not read vault tokens or
 * host secret files here.
 */

/** Env var name for the platform master key (KEK material, base64 32 bytes). */
export const PLATFORM_MASTER_KEY_ENV = 'PLATFORM_MASTER_KEY';

/** Optional key id override for EnvKeyProvider (default: env:default). */
export const PLATFORM_MASTER_KEY_ID_ENV = 'PLATFORM_MASTER_KEY_ID';

export const DEFAULT_ENV_KEY_ID = 'env:default';

/** Cipher envelope algorithm identifier (AES-256-GCM). */
export const ENVELOPE_ALG = 'A256GCM' as const;

/** Current envelope format version. */
export const ENVELOPE_VERSION = 1 as const;

/** Prefix for self-describing ciphertext strings. */
export const CIPHERTEXT_PREFIX = 'aihub.secret';

export type PlatformSecretEnv = Record<string, string | undefined>;

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
