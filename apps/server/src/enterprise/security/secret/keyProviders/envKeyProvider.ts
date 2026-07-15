import {
  DEFAULT_ENV_KEY_ID,
  parsePlatformSecretConfig,
  PLATFORM_MASTER_KEY_ENV,
  type PlatformSecretEnv,
} from '../config';
import { secretInvalidInput, secretMasterKeyMissing, secretNotReadable } from '../errors';
import type { KekMaterial, KeyProvider } from './types';

const AES_256_KEY_BYTES = 32;

export interface EnvKeyProviderOptions {
  env?: PlatformSecretEnv;
  /** Key id stamped into envelopes (default env:default). */
  keyId?: string;
  /** Pre-parsed base64 master key (test injection). */
  masterKeyBase64?: string;
}

/**
 * KEK from PLATFORM_MASTER_KEY (base64-encoded 32 bytes).
 * Suitable for single-node / dev; production G-03 prefers Vault/KMS (W8).
 */
export class EnvKeyProvider implements KeyProvider {
  readonly providerId = 'env';

  private readonly key: Uint8Array;
  private readonly keyId: string;

  constructor(options: EnvKeyProviderOptions = {}) {
    const config = parsePlatformSecretConfig(options.env);
    const b64 = options.masterKeyBase64 ?? config.masterKeyBase64;
    this.keyId = options.keyId ?? config.masterKeyId;

    if (!b64) {
      throw secretMasterKeyMissing(
        `${PLATFORM_MASTER_KEY_ENV} is not set. Cannot initialize EnvKeyProvider.`,
      );
    }

    let raw: Buffer;
    try {
      raw = Buffer.from(b64, 'base64');
    } catch {
      throw secretInvalidInput(`${PLATFORM_MASTER_KEY_ENV} is not valid base64.`);
    }

    if (raw.length !== AES_256_KEY_BYTES) {
      throw secretInvalidInput(
        `${PLATFORM_MASTER_KEY_ENV} must decode to ${AES_256_KEY_BYTES} bytes (AES-256), got ${raw.length}. ` +
          'Generate with: openssl rand -base64 32',
      );
    }

    this.key = new Uint8Array(raw);
  }

  async getKek(keyId?: string): Promise<KekMaterial> {
    if (keyId !== undefined && keyId !== this.keyId) {
      throw secretNotReadable(`Unknown key id for EnvKeyProvider: ${keyId}`, { keyId });
    }
    return { key: this.key, keyId: this.keyId };
  }

  /** Convenience: active key id without exposing key bytes. */
  getActiveKeyId(): string {
    return this.keyId;
  }

  static tryCreate(options: EnvKeyProviderOptions = {}): EnvKeyProvider | null {
    const config = parsePlatformSecretConfig(options.env);
    if (!(options.masterKeyBase64 ?? config.masterKeyBase64)) return null;
    return new EnvKeyProvider(options);
  }
}

export { DEFAULT_ENV_KEY_ID };
