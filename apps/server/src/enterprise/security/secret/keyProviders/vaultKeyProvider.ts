import { secretInvalidInput } from '../errors';
import type { KekMaterial, KeyProvider } from './types';

/**
 * VaultKeyProvider — interface contract + fail-closed stub.
 *
 * W8 integration points (do not implement here):
 * - Auth: AppRole (preferred) or low-privilege token — never root.
 * - Engine: KV v2 at mount `aihub/` (local Vault: 127.0.0.1:8200).
 * - Path convention (proposed): `aihub/data/platform/master-key` with
 *   fields `{ key: base64, keyId: string }` or Transit encrypt/decrypt API.
 * - Sealed Vault: fail closed; do not fall back to env silently in prod.
 * - Rotation: dual-read old/new keyId during re-wrap window.
 *
 * See: docs/redevelopment/overview/03_阶段0_环境准备记录.md §5 KMS/Vault.
 */
export interface VaultKeyProviderOptions {
  /** Vault API address, e.g. http://127.0.0.1:8200 */
  address?: string;
  /** Optional explicit key id override. */
  keyId?: string;
  /** KV v2 mount path (default aihub). */
  mountPath?: string;
  /** Secret path under the mount (without data/ prefix). */
  secretPath?: string;
}

export class VaultKeyProvider implements KeyProvider {
  readonly providerId = 'vault';

  readonly address: string;
  readonly mountPath: string;
  readonly secretPath: string;
  readonly keyId: string;

  constructor(options: VaultKeyProviderOptions = {}) {
    this.address = options.address ?? 'http://127.0.0.1:8200';
    this.mountPath = options.mountPath ?? 'aihub';
    this.secretPath = options.secretPath ?? 'platform/master-key';
    this.keyId = options.keyId ?? `vault:${this.mountPath}/${this.secretPath}`;
  }

  /**
   * Stub: real fetch from Vault KV v2 lands in W8.
   * Always rejects so mis-wiring fails closed rather than encrypting with empty KEK.
   */
  async getKek(_keyId?: string): Promise<KekMaterial> {
    throw secretInvalidInput(
      'VaultKeyProvider is a stub (W8). Wire AppRole/KV v2 before use. ' +
        `Configured target: ${this.address}/v1/${this.mountPath}/data/${this.secretPath}`,
      {
        address: this.address,
        keyId: this.keyId,
        mountPath: this.mountPath,
        secretPath: this.secretPath,
        w8: true,
      },
    );
  }
}
