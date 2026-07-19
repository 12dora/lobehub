import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';

import { isAnyEnterpriseFeatureEnabled } from '../../featureFlags';
import {
  parsePlatformSecretConfig,
  PLATFORM_MASTER_KEY_ENV,
  type PlatformSecretEnv,
} from './config';
import { getEnvelopeKeyId, openEnvelope, parseEnvelopeString, sealEnvelope } from './envelope';
import { secretInvalidInput, secretMasterKeyMissing } from './errors';
import { EnvKeyProvider, type KeyProvider } from './keyProviders';

export interface PlatformSecretServiceOptions {
  keyProvider: KeyProvider;
}

/**
 * Storage-agnostic envelope encryption for platform secrets
 * (Provider keys, Connector shared secrets, OIDC client secrets).
 *
 * - encrypt/decrypt/rotate operate on opaque ciphertext strings only
 * - no DB tables / migrations (consumers store the string)
 * - plaintext lifetime is caller-owned; do not log return values
 */
export class PlatformSecretService {
  private readonly keyProvider: KeyProvider;

  constructor(options: PlatformSecretServiceOptions) {
    this.keyProvider = options.keyProvider;
  }

  /**
   * Encrypt plaintext → self-describing ciphertext
   * (`aihub.secret.v1.<payload>` with kid/alg for rotation).
   */
  encrypt = async (plaintext: string | Uint8Array): Promise<string> => {
    const bytes =
      typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : new Uint8Array(plaintext);
    const { key, keyId } = await this.keyProvider.getKek();
    return sealEnvelope({ kek: key, keyId, plaintext: bytes });
  };

  /** Decrypt ciphertext → utf8 plaintext. Fails closed on wrong key / tamper / unknown version. */
  decrypt = async (ciphertext: string): Promise<string> => {
    const envelope = parseEnvelopeString(ciphertext);
    const { key } = await this.keyProvider.getKek(envelope.kid);
    const plain = openEnvelope({ envelope, kek: key });
    return plain.toString('utf8');
  };

  /**
   * Re-wrap: decrypt with the key id embedded in the envelope,
   * re-encrypt with the provider's current/active KEK.
   */
  rotate = async (ciphertext: string): Promise<string> => {
    const plaintext = await this.decrypt(ciphertext);
    try {
      return await this.encrypt(plaintext);
    } finally {
      // best-effort: string is immutable in JS; avoid retaining ref longer than needed
    }
  };

  /** Read key id from ciphertext without decrypting (fingerprint / rotation planning). */
  peekKeyId = (ciphertext: string): string => getEnvelopeKeyId(ciphertext);

  /**
   * Sign a bounded platform artifact without exposing or re-reading the master key.
   * HKDF domain separation prevents a signature from one artifact class being
   * accepted by another consumer that uses the same KeyProvider.
   */
  signArtifact = async (domain: string, payload: string): Promise<string> => {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(domain)) {
      throw secretInvalidInput('Artifact signature domain is invalid');
    }
    const { key, keyId } = await this.keyProvider.getKek();
    const signingKey = Buffer.from(
      hkdfSync(
        'sha256',
        key,
        Buffer.from('aihub.platform.artifact-signature.v1', 'utf8'),
        Buffer.from(domain, 'utf8'),
        32,
      ),
    );
    try {
      const signature = createHmac('sha256', signingKey)
        .update(payload, 'utf8')
        .digest('base64url');
      return `aihub.signature.v1.${Buffer.from(keyId, 'utf8').toString('base64url')}.${signature}`;
    } finally {
      signingKey.fill(0);
    }
  };

  verifyArtifact = async (domain: string, payload: string, signature: string): Promise<boolean> => {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(domain)) return false;
    const parts = signature.split('.');
    if (
      parts.length !== 5 ||
      parts[0] !== 'aihub' ||
      parts[1] !== 'signature' ||
      parts[2] !== 'v1'
    ) {
      return false;
    }
    let keyId: string;
    let supplied: Buffer;
    try {
      keyId = Buffer.from(parts[3]!, 'base64url').toString('utf8');
      supplied = Buffer.from(parts[4]!, 'base64url');
    } catch {
      return false;
    }
    if (!keyId || supplied.length !== 32) return false;
    const { key } = await this.keyProvider.getKek(keyId);
    const signingKey = Buffer.from(
      hkdfSync(
        'sha256',
        key,
        Buffer.from('aihub.platform.artifact-signature.v1', 'utf8'),
        Buffer.from(domain, 'utf8'),
        32,
      ),
    );
    try {
      const expected = createHmac('sha256', signingKey).update(payload, 'utf8').digest();
      return timingSafeEqual(expected, supplied);
    } finally {
      signingKey.fill(0);
    }
  };

  /**
   * Build service from PLATFORM_MASTER_KEY when present.
   * Returns null when key is absent (caller decides based on feature flags).
   */
  static tryFromEnv(env: PlatformSecretEnv = process.env): PlatformSecretService | null {
    const provider = EnvKeyProvider.tryCreate({ env });
    if (!provider) return null;
    return new PlatformSecretService({ keyProvider: provider });
  }

  /**
   * Fail-closed factory: enterprise flags ON require a master key.
   * Flags OFF → returns null without throwing (upstream behavior unchanged).
   */
  static fromEnvOrThrowIfEnterprise(
    env: PlatformSecretEnv = process.env,
    flags?: EnterpriseFeatureFlags,
  ): PlatformSecretService | null {
    const enterpriseOn = flags
      ? isAnyEnterpriseFeatureEnabled(flags)
      : isAnyEnterpriseFeatureEnabled();

    const service = PlatformSecretService.tryFromEnv(env);
    if (service) return service;

    if (enterpriseOn) {
      throw secretMasterKeyMissing(
        `Enterprise features are enabled but ${PLATFORM_MASTER_KEY_ENV} is missing. ` +
          'Refuse to start secret-dependent paths. Generate with: openssl rand -base64 32',
      );
    }
    return null;
  }
}

/**
 * Startup gate: when any enterprise feature flag is on, PLATFORM_MASTER_KEY
 * must be present and well-formed. When all flags are off, no-op.
 *
 * Call from enterprise bootstrap (M07/M09/M11 wire-up); does not attach tRPC.
 */
export const assertPlatformMasterKeyIfEnterprise = (
  env: PlatformSecretEnv = process.env,
  flags?: EnterpriseFeatureFlags,
): void => {
  const enterpriseOn = flags
    ? isAnyEnterpriseFeatureEnabled(flags)
    : isAnyEnterpriseFeatureEnabled();

  if (!enterpriseOn) return;

  const config = parsePlatformSecretConfig(env);
  if (!config.masterKeyBase64) {
    throw secretMasterKeyMissing();
  }

  // Validate shape early (same rules as EnvKeyProvider)
  try {
    new EnvKeyProvider({ env });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw secretInvalidInput(String(error));
  }
};
