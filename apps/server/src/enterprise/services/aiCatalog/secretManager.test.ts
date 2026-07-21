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

  it('merge overlays non-empty fields and retains unsubmitted vault keys', async () => {
    const seed = await manager.applyMutation(null, {
      operation: 'replace',
      value: { apiKey: 'seed-api-key', region: 'us-east-1' },
    });
    const merged = await manager.applyMutation(seed, {
      operation: 'merge',
      value: { apiKey: 'rotated-api-key' },
    });
    expect(JSON.stringify(merged)).not.toContain('seed-api-key');
    expect(JSON.stringify(merged)).not.toContain('rotated-api-key');
    expect(await manager.decrypt(merged.encryptedKeyVaults!)).toEqual({
      apiKey: 'rotated-api-key',
      region: 'us-east-1',
    });
  });

  it('merge ignores empty-string fields so accidental blanks do not wipe secrets', async () => {
    const seed = await manager.applyMutation(null, {
      operation: 'replace',
      value: { apiKey: 'keep-me', region: 'ap-east-1' },
    });
    const merged = await manager.applyMutation(seed, {
      operation: 'merge',
      value: { apiKey: '', region: 'eu-west-1' },
    });
    expect(await manager.decrypt(merged.encryptedKeyVaults!)).toEqual({
      apiKey: 'keep-me',
      region: 'eu-west-1',
    });
  });

  it('merge onto empty vault acts like replace for non-empty fields only', async () => {
    const merged = await manager.applyMutation(null, {
      operation: 'merge',
      value: { apiKey: 'first-key', baseURL: '' },
    });
    expect(await manager.decrypt(merged.encryptedKeyVaults!)).toEqual({ apiKey: 'first-key' });
  });
});
