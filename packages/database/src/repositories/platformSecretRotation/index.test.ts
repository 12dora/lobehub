// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformAiProviders,
  platformAiProviderSecrets,
  platformConnectors,
  platformConnectorSecrets,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformSecretRotationRepository } from '.';

const db: LobeChatDatabase = await getTestDB();
const repository = new PlatformSecretRotationRepository(db);
const oldKeyId = 'vault:test-old';
const targetKeyId = 'vault:test-target';
const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);
const opaque = (label: string) => `opaque-test-material:${label}`;

const cleanup = async () => {
  await db.delete(platformIdentityProviderTestAttempts);
  await db.delete(platformIdentityProviderSecrets);
  await db.delete(platformIdentityProviders);
  await db.delete(platformConnectorSecrets);
  await db.delete(platformConnectors);
  await db.delete(platformAiProviderSecrets);
  await db.delete(platformAiProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

const seedFiveDomains = async () => {
  const aiCiphertext = opaque('ai-old');
  await db.insert(platformAiProviders).values([
    {
      displayName: 'AI current and immutable',
      encryptedKeyVaults: aiCiphertext,
      id: 'ai-a',
      providerKey: 'ai-a',
      secretFingerprint: fingerprintA,
      secretKeyId: oldKeyId,
      secretKeyVersion: 1,
    },
    {
      displayName: 'AI legacy null key id',
      encryptedKeyVaults: opaque('ai-null'),
      id: 'ai-null',
      providerKey: 'ai-null',
      secretFingerprint: fingerprintB,
      secretKeyId: null,
      secretKeyVersion: 1,
    },
    {
      displayName: 'Already target',
      encryptedKeyVaults: opaque('ai-target'),
      id: 'ai-target',
      providerKey: 'ai-target',
      secretFingerprint: 'c'.repeat(64),
      secretKeyId: targetKeyId,
      secretKeyVersion: 1,
    },
  ]);
  await db.insert(platformAiProviderSecrets).values({
    ciphertext: aiCiphertext,
    fingerprint: fingerprintA,
    id: 'ai-version-a',
    keyId: null,
    keyVersion: 1,
    providerId: 'ai-a',
  });

  await db.insert(platformConnectors).values({
    connectorKey: 'connector-a',
    displayName: 'Connector A',
    id: 'connector-a',
    legacyName: 'Connector A',
    migrationRequired: true,
  });
  await db.insert(platformConnectorSecrets).values({
    ciphertext: opaque('connector-old'),
    connectorId: 'connector-a',
    fingerprint: fingerprintA,
    id: 'connector-secret-a',
    keyId: oldKeyId,
    ref: 'kms://platform-connectors/connector-a/shared',
    revokedAt: new Date(),
    revision: 3,
    slot: 'sharedSecret',
  });

  await db.insert(platformIdentityProviders).values({
    displayName: 'Identity A',
    id: 'identity-a',
    providerKey: 'identity-a',
  });
  await db.insert(platformIdentityProviderSecrets).values({
    ciphertext: opaque('identity-old'),
    fingerprint: fingerprintA,
    id: 'identity-secret-a',
    keyId: oldKeyId,
    providerId: 'identity-a',
    ref: 'kms://platform-identity-providers/identity-a/secret',
    revokedAt: new Date(),
    revision: 4,
  });

  const createdAt = new Date(Date.now() - 20 * 60 * 1000);
  await db.insert(platformIdentityProviderTestAttempts).values({
    auditReason: 'rotation test flow',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
    id: 'identity-test-a',
    nonceHash: 'd'.repeat(64),
    pkceCiphertext: opaque('pkce-old'),
    pkceKeyId: oldKeyId,
    providerId: 'identity-a',
    providerRevision: 0,
    providerSecretFingerprint: fingerprintA,
    providerSecretRef: 'kms://platform-identity-providers/identity-a/secret',
    redirectUri: 'https://example.test/oidc/callback',
    sessionId: 'session-a',
    stateHash: 'e'.repeat(64),
    userId: 'user-a',
  });
};

describe('PlatformSecretRotationRepository', () => {
  it('lists all five domains in fixed keyset order, including legacy/revoked/expired rows', async () => {
    await seedFiveDomains();
    const seen: string[] = [];
    let cursor = undefined;

    do {
      const page = await repository.listCandidates({ cursor, limit: 2, targetKeyId });
      for (const item of page.items) {
        seen.push(`${item.domain}:${item.id}`);
        expect(JSON.stringify(item)).toBe('{}');
        expect(Object.keys(item)).toHaveLength(0);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual([
      'aiCurrent:ai-a',
      'aiCurrent:ai-null',
      'aiImmutable:ai-version-a',
      'connector:connector-secret-a',
      'identityProvider:identity-secret-a',
      'identityProviderTestPkce:identity-test-a',
    ]);
    expect(seen.some((ref) => ref.includes('ai-target'))).toBe(false);
  });

  it('applies exact CAS across all five domains and synchronizes matching AI dual copies', async () => {
    await seedFiveDomains();
    const { items } = await repository.listCandidates({ limit: 50, targetKeyId });
    const immutable = items.find(({ domain }) => domain === 'aiImmutable')!;
    const immutableResult = await repository.rotateExact({
      candidate: immutable,
      ciphertext: opaque('ai-new'),
      targetKeyId,
    });
    expect(immutableResult).toEqual({ currentSynchronized: true, updated: true });

    for (const candidate of items.filter(
      ({ domain, id }) => domain !== 'aiImmutable' && !(domain === 'aiCurrent' && id === 'ai-a'),
    )) {
      const result = await repository.rotateExact({
        candidate,
        ciphertext: opaque(`new-${candidate.domain}-${candidate.id}`),
        targetKeyId,
      });
      expect(result.updated).toBe(true);
    }

    const staleCurrent = items.find(({ domain, id }) => domain === 'aiCurrent' && id === 'ai-a')!;
    await expect(
      repository.rotateExact({
        candidate: staleCurrent,
        ciphertext: opaque('must-not-overwrite'),
        targetKeyId,
      }),
    ).resolves.toEqual({ currentSynchronized: false, updated: false });

    const [aiCurrent] = await db
      .select()
      .from(platformAiProviders)
      .where(eq(platformAiProviders.id, 'ai-a'));
    const [aiVersion] = await db
      .select()
      .from(platformAiProviderSecrets)
      .where(eq(platformAiProviderSecrets.id, 'ai-version-a'));
    expect(aiCurrent.secretKeyId).toBe(targetKeyId);
    expect(aiVersion.keyId).toBe(targetKeyId);
    expect(aiCurrent.encryptedKeyVaults === opaque('ai-new')).toBe(true);
    expect(aiVersion.ciphertext === opaque('ai-new')).toBe(true);
  });

  it('never overwrites a concurrent secret replacement after inventory', async () => {
    await seedFiveDomains();
    const { items } = await repository.listCandidates({ limit: 50, targetKeyId });
    const candidate = items.find(({ domain, id }) => domain === 'aiCurrent' && id === 'ai-null')!;
    const replacement = opaque('concurrent-replacement');
    await db
      .update(platformAiProviders)
      .set({ encryptedKeyVaults: replacement, secretKeyId: 'vault:concurrent' })
      .where(eq(platformAiProviders.id, candidate.id));

    const result = await repository.rotateExact({
      candidate,
      ciphertext: opaque('stale-rotation'),
      targetKeyId,
    });
    const [stored] = await db
      .select()
      .from(platformAiProviders)
      .where(eq(platformAiProviders.id, candidate.id));
    expect(result.updated).toBe(false);
    expect(stored.encryptedKeyVaults === replacement).toBe(true);
    expect(stored.secretKeyId).toBe('vault:concurrent');
  });

  it('rotates immutable history without syncing a drifted AI current copy', async () => {
    await seedFiveDomains();
    const { items } = await repository.listCandidates({ limit: 50, targetKeyId });
    const candidate = items.find(({ domain }) => domain === 'aiImmutable')!;
    const drifted = opaque('drifted-current');
    await db
      .update(platformAiProviders)
      .set({ encryptedKeyVaults: drifted, secretFingerprint: fingerprintB })
      .where(eq(platformAiProviders.id, 'ai-a'));

    const result = await repository.rotateExact({
      candidate,
      ciphertext: opaque('history-new'),
      targetKeyId,
    });
    const [current] = await db
      .select()
      .from(platformAiProviders)
      .where(eq(platformAiProviders.id, 'ai-a'));
    expect(result).toEqual({ currentSynchronized: false, updated: true });
    expect(current.encryptedKeyVaults === drifted).toBe(true);
    expect(current.secretKeyId).toBe(oldKeyId);
  });

  it('caps page size at fifty', async () => {
    await db.insert(platformAiProviders).values(
      Array.from({ length: 51 }, (_, index) => ({
        displayName: `AI ${index}`,
        encryptedKeyVaults: opaque(`bulk-${index}`),
        id: `bulk-${String(index).padStart(2, '0')}`,
        providerKey: `bulk-${index}`,
        secretKeyId: oldKeyId,
        secretKeyVersion: 1,
      })),
    );
    const page = await repository.listCandidates({ limit: 500, targetKeyId });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
  });

  it('supports transaction-scoped getById without making ciphertext enumerable', async () => {
    await seedFiveDomains();
    await db.transaction(async (tx) => {
      const candidate = await PlatformSecretRotationRepository.forTransaction(tx).getById(
        'connector',
        'connector-secret-a',
      );
      expect(candidate).toBeDefined();
      expect(candidate?.domain).toBe('connector');
      expect(candidate?.ciphertext).toBe(opaque('connector-old'));
      expect(Object.keys(candidate!)).toEqual([]);
      expect(JSON.stringify(candidate)).toBe('{}');
    });
  });
});
