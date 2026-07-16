// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import { platformConnectors, platformConnectorSecrets } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { type KeyProvider, PlatformSecretService } from '../../security/secret';
import { ensurePendingM09ServiceSchema } from './catalogTestUtils';
import { PlatformConnectorContractError } from './errors';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';

const connectorIds = ['m09-secret-store-a', 'm09-secret-store-b'];
const keyA = new Uint8Array(32).fill(1);
const keyB = new Uint8Array(32).fill(2);

let db: LobeChatDatabase;

const cleanup = async () => {
  await db
    .delete(platformConnectorSecrets)
    .where(eq(platformConnectorSecrets.connectorId, connectorIds[0]));
  await db
    .delete(platformConnectorSecrets)
    .where(eq(platformConnectorSecrets.connectorId, connectorIds[1]));
  await db.delete(platformConnectors).where(eq(platformConnectors.id, connectorIds[0]));
  await db.delete(platformConnectors).where(eq(platformConnectors.id, connectorIds[1]));
};

beforeAll(async () => {
  db = await getTestDB();
  await ensurePendingM09ServiceSchema(db);
  await cleanup();
  const repository = new PlatformConnectorCatalogRepository(db);
  for (const connectorId of connectorIds) {
    await repository.createConnector({
      connectorKey: connectorId,
      credentialMode: 'none',
      displayName: connectorId,
      endpoint: 'https://connector.example.test/mcp',
      id: connectorId,
    });
  }
});

afterAll(cleanup);

describe('PlatformConnectorSecretStore', () => {
  it('persists only an M13 envelope and enforces connector + slot ownership', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const plaintext = 'owner-scoped-oauth-token-value';
    const stored = await store.persistSecret({
      connectorId: connectorIds[0],
      slot: 'oauthBindingToken',
      value: { accessToken: plaintext },
    });

    const [row] = await db
      .select()
      .from(platformConnectorSecrets)
      .where(eq(platformConnectorSecrets.ref, stored.ref));
    expect(row.ciphertext).toMatch(/^aihub\.secret\.v1\./);
    expect(row.ciphertext).not.toContain(plaintext);
    expect(row.ref).not.toContain(plaintext);
    expect(row.keyId).toBe('test:key-a');
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[1],
        ref: stored.ref,
        slot: 'oauthBindingToken',
      }),
    ).resolves.toBeNull();
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[0],
        ref: stored.ref,
        slot: 'oauthPkceVerifier',
      }),
    ).resolves.toBeNull();
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[0],
        ref: stored.ref,
        slot: 'oauthBindingToken',
      }),
    ).resolves.toMatchObject({ value: { accessToken: plaintext } });
  });

  it('rotates key metadata without changing the opaque handle or fingerprint', async () => {
    let activeKeyId = 'test:key-a';
    const keyProvider: KeyProvider = {
      getKek: async (keyId) => {
        const requested = keyId ?? activeKeyId;
        return requested === 'test:key-a'
          ? { key: keyA, keyId: requested }
          : { key: keyB, keyId: requested };
      },
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const stored = await store.persistSecret({
      connectorId: connectorIds[0],
      slot: 'oauthPkceVerifier',
      value: 'v'.repeat(64),
    });
    activeKeyId = 'test:key-b';
    await expect(
      store.rotateSecretRef({
        connectorId: connectorIds[0],
        ref: stored.ref,
        slot: 'oauthPkceVerifier',
      }),
    ).resolves.toMatchObject(stored);
    const [row] = await db
      .select()
      .from(platformConnectorSecrets)
      .where(eq(platformConnectorSecrets.ref, stored.ref));
    expect(row).toMatchObject({ keyId: 'test:key-b', revision: 2 });
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[0],
        ref: stored.ref,
        slot: 'oauthPkceVerifier',
      }),
    ).resolves.toMatchObject({ value: 'v'.repeat(64) });
  });

  it('fails closed on an invalid envelope and makes revoked handles unreadable', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const invalid = await store.persistSecret({
      connectorId: connectorIds[1],
      slot: 'sharedSecret',
      value: 'never-log-this',
    });
    await db
      .update(platformConnectorSecrets)
      .set({ ciphertext: 'invalid-envelope' })
      .where(eq(platformConnectorSecrets.ref, invalid.ref));
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[1],
        ref: invalid.ref,
        slot: 'sharedSecret',
      }),
    ).rejects.toBeInstanceOf(PlatformConnectorContractError);

    const revoked = await store.persistSecret({
      connectorId: connectorIds[1],
      slot: 'oauthClientSecret',
      value: 'client-secret',
    });
    await store.revokeSecretRef({
      connectorId: connectorIds[1],
      ref: revoked.ref,
      slot: 'oauthClientSecret',
    });
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[1],
        ref: revoked.ref,
        slot: 'oauthClientSecret',
      }),
    ).resolves.toBeNull();
  });
});
