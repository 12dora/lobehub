// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { IdentityProviderSecretStore } from './secretStore';

const serverDB: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(29), keyId: 'test-key' }),
  providerId: 'test',
};
const store = new IdentityProviderSecretStore(serverDB, new PlatformSecretService({ keyProvider }));

const cleanup = async () => {
  await serverDB.delete(platformIdentityProviderSecrets);
  await serverDB.delete(platformIdentityProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('IdentityProviderSecretStore', () => {
  it('stores envelope ciphertext and returns metadata only', async () => {
    const secret = randomUUID();
    const [provider] = await serverDB
      .insert(platformIdentityProviders)
      .values({ displayName: 'Work', providerKey: 'work' })
      .returning();

    const result = await store.persistClientSecret(provider.id, secret);
    const [row] = await serverDB.select().from(platformIdentityProviderSecrets);
    expect(result).toMatchObject({
      configured: true,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(row.ciphertext).toMatch(/^aihub\.secret\.v1\./);
    expect(row.ciphertext).not.toContain(secret);
    expect(await store.resolveCurrentClientSecret(provider.id)).toBe(secret);
  });

  it('keeps historical versions resolvable while clear removes only the current pointer', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const [provider] = await serverDB
      .insert(platformIdentityProviders)
      .values({ displayName: 'Work', providerKey: 'work' })
      .returning();
    const firstState = await store.persistClientSecret(provider.id, first);
    await store.persistClientSecret(provider.id, second);

    expect(await store.resolveClientSecretVersion(provider.id, firstState.fingerprint)).toBe(first);
    expect(await store.clearCurrentClientSecret(provider.id)).toBe(true);
    expect(await store.resolveCurrentClientSecret(provider.id)).toBeNull();
    expect(await store.resolveClientSecretVersion(provider.id, firstState.fingerprint)).toBe(first);
    expect(await store.resolveClientSecretVersion(provider.id, 'invalid')).toBeNull();
  });
});
