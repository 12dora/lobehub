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

    const result = await store.persistClientSecret({
      expectedRevision: provider.revision,
      providerId: provider.id,
      value: secret,
    });
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
    const firstState = await store.persistClientSecret({
      expectedRevision: 0,
      providerId: provider.id,
      value: first,
    });
    await store.persistClientSecret({
      expectedRevision: 1,
      providerId: provider.id,
      value: second,
    });

    expect(await store.resolveClientSecretVersion(provider.id, firstState.fingerprint)).toBe(first);
    expect(
      await store.clearCurrentClientSecret({ expectedRevision: 2, providerId: provider.id }),
    ).toMatchObject({ configured: false, revision: 3 });
    expect(await store.resolveCurrentClientSecret(provider.id)).toBeNull();
    expect(await store.resolveClientSecretVersion(provider.id, firstState.fingerprint)).toBe(first);
    expect(await store.resolveClientSecretVersion(provider.id, 'invalid')).toBeNull();
  });

  it('uses revision CAS and reuses a repeated fingerprint version', async () => {
    const [provider] = await serverDB
      .insert(platformIdentityProviders)
      .values({ displayName: 'Work', providerKey: 'work' })
      .returning();
    const value = randomUUID();
    await store.persistClientSecret({ expectedRevision: 0, providerId: provider.id, value });
    await expect(
      store.persistClientSecret({ expectedRevision: 0, providerId: provider.id, value: 'stale' }),
    ).rejects.toMatchObject({ code: 'PLATFORM_REVISION_CONFLICT' });
    await store.persistClientSecret({ expectedRevision: 1, providerId: provider.id, value });
    expect(await serverDB.select().from(platformIdentityProviderSecrets)).toHaveLength(1);
    const [current] = await serverDB
      .select({ revision: platformIdentityProviders.revision })
      .from(platformIdentityProviders);
    expect(current.revision).toBe(2);
  });

  it('allows only one concurrent mutation for the same expected revision', async () => {
    const [provider] = await serverDB
      .insert(platformIdentityProviders)
      .values({ displayName: 'Work', providerKey: 'work' })
      .returning();
    const results = await Promise.allSettled([
      store.persistClientSecret({
        expectedRevision: 0,
        providerId: provider.id,
        value: randomUUID(),
      }),
      store.persistClientSecret({
        expectedRevision: 0,
        providerId: provider.id,
        value: randomUUID(),
      }),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'PLATFORM_REVISION_CONFLICT' } });
  });

  it('supports an owning transaction and rolls back when encryption is unavailable', async () => {
    const [provider] = await serverDB
      .insert(platformIdentityProviders)
      .values({ displayName: 'Work', providerKey: 'work' })
      .returning();
    await serverDB.transaction(async (tx) => {
      const transactional = new IdentityProviderSecretStore(
        tx,
        new PlatformSecretService({ keyProvider }),
      );
      await transactional.persistClientSecret({
        expectedRevision: 0,
        providerId: provider.id,
        value: randomUUID(),
      });
    });
    const unavailable = new IdentityProviderSecretStore(
      serverDB,
      new PlatformSecretService({
        keyProvider: {
          getKek: async () => {
            throw new Error('vault unavailable');
          },
          providerId: 'unavailable',
        },
      }),
    );
    await expect(
      unavailable.persistClientSecret({
        expectedRevision: 1,
        providerId: provider.id,
        value: randomUUID(),
      }),
    ).rejects.toThrow('vault unavailable');
    const [current] = await serverDB
      .select({ revision: platformIdentityProviders.revision })
      .from(platformIdentityProviders);
    expect(current.revision).toBe(1);
  });

  it('rejects invalid values and stale clear operations', async () => {
    const [provider] = await serverDB
      .insert(platformIdentityProviders)
      .values({ displayName: 'Work', providerKey: 'work' })
      .returning();
    await expect(
      store.persistClientSecret({ expectedRevision: 0, providerId: provider.id, value: '' }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_SECRET_INVALID');
    await expect(
      store.persistClientSecret({
        expectedRevision: 0,
        providerId: provider.id,
        value: 'x'.repeat(32_769),
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_SECRET_INVALID');
    await store.clearCurrentClientSecret({ expectedRevision: 0, providerId: provider.id });
    await expect(
      store.clearCurrentClientSecret({ expectedRevision: 0, providerId: provider.id }),
    ).rejects.toMatchObject({ code: 'PLATFORM_REVISION_CONFLICT' });
  });

  it('fails closed with a stable error when stored ciphertext cannot be decrypted', async () => {
    const ref = `kms://platform-identity-providers/provider/${randomUUID()}`;
    const [provider] = await serverDB
      .insert(platformIdentityProviders)
      .values({
        displayName: 'Work',
        providerKey: 'work',
        secretFingerprint: 'a'.repeat(64),
        secretRef: ref,
        secretUpdatedAt: new Date(),
      })
      .returning();
    await serverDB.insert(platformIdentityProviderSecrets).values({
      ciphertext: 'not-an-envelope',
      fingerprint: 'a'.repeat(64),
      keyId: 'invalid',
      providerId: provider.id,
      ref,
    });
    await expect(store.resolveCurrentClientSecret(provider.id)).rejects.toThrow(
      'PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE',
    );
  });
});
