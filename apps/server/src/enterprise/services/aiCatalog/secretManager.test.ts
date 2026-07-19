// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogSecretManager } from './secretManager';

const key = new Uint8Array(32).fill(17);
const keyProvider: KeyProvider = {
  getKek: async () => ({ key, keyId: 'test-key' }),
  providerId: 'test',
};

describe('AiCatalogSecretManager', () => {
  const manager = new AiCatalogSecretManager(new PlatformSecretService({ keyProvider }));

  it('replaces, keeps and clears without returning plaintext', async () => {
    const replaced = await manager.applyMutation(null, {
      operation: 'replace',
      value: 'fake-api-key',
    });
    expect(replaced.encryptedKeyVaults).toMatch(/^aihub\.secret\.v1\./);
    expect(replaced.secretKeyId).toBe('test-key');
    expect(JSON.stringify(replaced)).not.toContain('fake-api-key');
    expect(await manager.decrypt(replaced.encryptedKeyVaults!)).toEqual({ apiKey: 'fake-api-key' });

    const kept = await manager.applyMutation(replaced, { operation: 'keep' });
    expect(kept).toEqual(replaced);

    const cleared = await manager.applyMutation(replaced, { operation: 'clear' });
    expect(cleared).toEqual({
      encryptedKeyVaults: null,
      secretFingerprint: null,
      secretKeyId: null,
      secretKeyVersion: null,
      secretUpdatedAt: null,
    });
  });

  it('fails closed for non-object decrypted values', async () => {
    const ciphertext = await new PlatformSecretService({ keyProvider }).encrypt('[]');
    await expect(manager.decrypt(ciphertext)).rejects.toThrow('PLATFORM_SECRET_NOT_READABLE');
  });
});
