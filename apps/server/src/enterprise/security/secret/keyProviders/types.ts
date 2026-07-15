/**
 * Pluggable KEK provider for envelope encryption.
 *
 * EnvKeyProvider — first-party, env-backed (local / single-node).
 * VaultKeyProvider — interface + stub only in this PR; real AppRole/KV
 *   integration is W8 (see docs/redevelopment/overview/03_阶段0_环境准备记录.md).
 */

/** 32-byte AES-256 key material plus opaque key id for ciphertext metadata. */
export interface KekMaterial {
  /** Raw 32-byte AES-256 key. Never log or serialize. */
  key: Uint8Array;
  /** Opaque id written into the ciphertext envelope (supports rotation). */
  keyId: string;
}

export interface KeyProvider {
  /**
   * Resolve KEK for encryption (current/active) or decryption (by keyId).
   * @param keyId - When set, return that specific key (decrypt/rotate path).
   *                When omitted, return the active encryption key.
   */
  getKek: (keyId?: string) => Promise<KekMaterial>;

  /** Stable provider name: "env" | "vault" | custom. */
  readonly providerId: string;
}
