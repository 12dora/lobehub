// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import {
  platformConnectors,
  platformConnectorSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { type KeyProvider, PlatformSecretService } from '../../security/secret';
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
  // Migration 0145: revisions reject row DELETE without the replica-role bypass.
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL session_replication_role = 'replica'`));
    await tx
      .delete(platformResourceRevisions)
      .where(inArray(platformResourceRevisions.resourceId, connectorIds));
  });
  await db.delete(platformConnectors).where(eq(platformConnectors.id, connectorIds[0]));
  await db.delete(platformConnectors).where(eq(platformConnectors.id, connectorIds[1]));
};

beforeAll(async () => {
  db = await getTestDB();
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
}, 60_000);

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

  it('exposes non-deterministic opaque fingerprints and rejects ciphertext substitution', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const secretService = new PlatformSecretService({ keyProvider });
    const store = new PlatformConnectorSecretStore(db, secretService);
    const value = { password: 'guessable' };
    const a = await store.persistSecret({
      connectorId: connectorIds[0],
      slot: 'sharedSecret',
      value,
    });
    const b = await store.persistSecret({
      connectorId: connectorIds[0],
      slot: 'sharedSecret',
      value,
    });
    // Same plaintext must not produce a deterministic public fingerprint (oracle).
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    // Substituting a valid envelope of different plaintext must fail integrity.
    await db
      .update(platformConnectorSecrets)
      .set({ ciphertext: await secretService.encrypt(JSON.stringify({ password: 'different' })) })
      .where(eq(platformConnectorSecrets.ref, a.ref));
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[0],
        ref: a.ref,
        slot: 'sharedSecret',
      }),
    ).rejects.toBeInstanceOf(PlatformConnectorContractError);
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

  it('retries orphan cleanup after the grace window without touching live references', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const orphan = await store.persistSecret({
      connectorId: connectorIds[0],
      slot: 'oauthBindingToken',
      value: { accessToken: 'orphan-token' },
    });
    await db
      .update(platformConnectorSecrets)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(platformConnectorSecrets.ref, orphan.ref));

    await expect(store.garbageCollectOrphanedOAuthSecrets()).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[0],
        ref: orphan.ref,
        slot: 'oauthBindingToken',
      }),
    ).resolves.toBeNull();
  });

  it('gc_preserves_client_secrets_referenced_by_published_revision_fingerprints', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const historical = await store.persistSecret({
      connectorId: connectorIds[0],
      slot: 'sharedSecret',
      value: { apiKey: 'historical-revision-secret' },
    });
    // Current connector row does not reference this ref (as if draft replaced it).
    await db
      .update(platformConnectors)
      .set({ sharedSecretFingerprint: null, sharedSecretRef: null })
      .where(eq(platformConnectors.id, connectorIds[0]));
    // Published revision still pins the fingerprint for rollback / historical runtime.
    await db.insert(platformResourceRevisions).values({
      checksum: 'a'.repeat(64),
      payload: {
        connector: {
          sharedSecretFingerprint: historical.fingerprint,
        },
      },
      resourceId: connectorIds[0],
      resourceType: 'connector',
      revision: 99,
      status: 'published',
    });
    await db
      .update(platformConnectorSecrets)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(platformConnectorSecrets.ref, historical.ref));

    await expect(store.garbageCollectOrphanedSecrets()).resolves.toBe(0);
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[0],
        ref: historical.ref,
        slot: 'sharedSecret',
      }),
    ).resolves.toMatchObject({ fingerprint: historical.fingerprint });

    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL session_replication_role = 'replica'`));
      await tx
        .delete(platformResourceRevisions)
        .where(eq(platformResourceRevisions.resourceId, connectorIds[0]));
    });
    await expect(store.garbageCollectOrphanedSecrets()).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      store.resolveSecretRef({
        connectorId: connectorIds[0],
        ref: historical.ref,
        slot: 'sharedSecret',
      }),
    ).resolves.toBeNull();
  });

  it('keeps opportunistic GC bounded and retries remaining rows on later calls', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const refs: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const stored = await store.persistSecret({
        connectorId: connectorIds[0],
        slot: 'oauthPkceVerifier',
        value: `orphan-verifier-${index}`,
      });
      refs.push(stored.ref);
    }
    await db
      .update(platformConnectorSecrets)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(inArray(platformConnectorSecrets.ref, refs));

    await expect(store.garbageCollectOrphanedOAuthSecrets(1)).resolves.toBe(1);
    await expect(store.garbageCollectOrphanedOAuthSecrets(1)).resolves.toBe(1);
    await expect(store.garbageCollectOrphanedOAuthSecrets(1)).resolves.toBe(1);
    for (const ref of refs) {
      await expect(
        store.resolveSecretRef({
          connectorId: connectorIds[0],
          ref,
          slot: 'oauthPkceVerifier',
        }),
      ).resolves.toBeNull();
    }
  });

  it('does not block a new secret when opportunistic GC fails or log secret material', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const privateFailure = 'private-gc-backend-response';
    vi.spyOn(store, 'garbageCollectOrphanedOAuthSecrets').mockRejectedValueOnce(
      new Error(privateFailure),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      store.persistSecret({
        connectorId: connectorIds[1],
        slot: 'oauthBindingToken',
        value: { accessToken: 'must-never-enter-log' },
      }),
    ).resolves.toMatchObject({ ref: expect.stringMatching(/^kms:\/\/platform-connectors\//) });
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /private-gc-backend-response|must-never-enter-log/,
    );
    vi.restoreAllMocks();
  });
});
