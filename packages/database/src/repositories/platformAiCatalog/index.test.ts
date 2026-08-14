// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { checksumPayload } from '../../models/platform/checksum';
import { platformAiProviderSecrets, platformResourceRevisions } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAiCatalogRepository } from '.';

const serverDB: LobeChatDatabase = await getTestDB();
const repository = new PlatformAiCatalogRepository(serverDB);

const cleanup = async () => {
  // TRUNCATE bypasses row-level immutability triggers (migration 0145).
  await serverDB.execute(
    sql.raw(`
      TRUNCATE TABLE
        platform_resource_revisions,
        platform_ai_models,
        platform_ai_providers
      CASCADE
    `),
  );
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformAiCatalogRepository', () => {
  it('enforces provider and provider/model business uniqueness', async () => {
    const provider = await repository.createProvider({
      displayName: 'Alpha',
      providerKey: 'alpha',
    });
    await expect(
      repository.createProvider({ displayName: 'Again', providerKey: 'alpha' }),
    ).rejects.toThrow();

    await repository.createModel({ modelKey: 'chat', providerId: provider.id });
    await expect(
      repository.createModel({ modelKey: 'chat', providerId: provider.id }),
    ).rejects.toThrow();

    const other = await repository.createProvider({ displayName: 'Beta', providerKey: 'beta' });
    await expect(
      repository.createModel({ modelKey: 'chat', providerId: other.id }),
    ).resolves.toMatchObject({ modelKey: 'chat', providerId: other.id });
  });

  it('cursor-paginates by the indexed stable provider key', async () => {
    for (const key of ['charlie', 'alpha', 'bravo']) {
      await repository.createProvider({ displayName: key, providerKey: key });
    }

    const first = await repository.listProviders({ limit: 2 });
    expect(first.items.map((item) => item.providerKey)).toEqual(['alpha', 'bravo']);
    expect(first.nextCursor).toBe('bravo');

    const second = await repository.listProviders({ cursor: first.nextCursor!, limit: 2 });
    expect(second.items.map((item) => item.providerKey)).toEqual(['charlie']);
    expect(second.nextCursor).toBeNull();
  });

  it('filters providers before pagination and globally paginates filtered models', async () => {
    const alpha = await repository.createProvider({
      displayName: 'Alpha Cloud',
      enabled: true,
      providerKey: 'alpha',
      source: 'custom',
    });
    const beta = await repository.createProvider({
      displayName: 'Beta Cloud',
      enabled: false,
      providerKey: 'beta',
      source: 'builtin',
    });
    await repository.createModel({
      displayName: 'Alpha Chat',
      enabled: true,
      modelKey: 'chat-a',
      providerId: alpha.id,
      sort: 1,
      type: 'chat',
    });
    await repository.createModel({
      displayName: 'Alpha Image',
      enabled: false,
      modelKey: 'image-a',
      providerId: alpha.id,
      sort: 2,
      type: 'image',
    });
    await repository.createModel({
      enabled: true,
      modelKey: 'chat-b',
      providerId: beta.id,
      sort: 1,
      type: 'chat',
    });

    const providers = await repository.listProviders({
      enabled: true,
      query: 'cloud',
      source: 'custom',
    });
    expect(providers.items.map((item) => item.providerKey)).toEqual(['alpha']);

    const first = await repository.listAllModels({ enabled: true, limit: 1, type: 'chat' });
    expect(first.items[0]).toMatchObject({ model: { modelKey: 'chat-a' }, providerKey: 'alpha' });
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.listAllModels({
      cursor: first.nextCursor!,
      enabled: true,
      limit: 1,
      type: 'chat',
    });
    expect(second.items[0]).toMatchObject({ model: { modelKey: 'chat-b' }, providerKey: 'beta' });

    const queried = await repository.listAllModels({ query: 'image', type: 'image' });
    expect(queried.items.map((item) => item.model.modelKey)).toEqual(['image-a']);
  });

  it('scopes model read/update/delete/reorder to its provider', async () => {
    const alpha = await repository.createProvider({ displayName: 'Alpha', providerKey: 'alpha' });
    const beta = await repository.createProvider({ displayName: 'Beta', providerKey: 'beta' });
    const model = await repository.createModel({ modelKey: 'chat', providerId: alpha.id, sort: 1 });

    expect(await repository.getModel(beta.id, model.id)).toBeUndefined();
    expect(
      await repository.updateModel(beta.id, model.id, { displayName: 'stolen' }),
    ).toBeUndefined();
    expect(await repository.reorderModels(beta.id, [{ id: model.id, sort: 99 }])).toBe(0);
    expect(await repository.deleteModel(beta.id, model.id)).toBeUndefined();

    const unchanged = await repository.getModel(alpha.id, model.id);
    expect(unchanged).toMatchObject({ displayName: null, sort: 1 });
  });

  it('reorders multiple owned models in one update and demotes them to draft', async () => {
    const alpha = await repository.createProvider({ displayName: 'Alpha', providerKey: 'alpha' });
    const beta = await repository.createProvider({ displayName: 'Beta', providerKey: 'beta' });
    const a = await repository.createModel({ modelKey: 'a', providerId: alpha.id, sort: 1 });
    const b = await repository.createModel({ modelKey: 'b', providerId: alpha.id, sort: 2 });
    const foreign = await repository.createModel({ modelKey: 'x', providerId: beta.id, sort: 1 });
    await repository.updateModel(alpha.id, a.id, { status: 'published' });
    await repository.updateModel(alpha.id, b.id, { status: 'published' });

    expect(
      await repository.reorderModels(alpha.id, [
        { id: b.id, sort: 10 },
        { id: a.id, sort: 20 },
        { id: foreign.id, sort: 99 },
      ]),
    ).toBe(2);

    expect(await repository.getModel(alpha.id, a.id)).toMatchObject({
      sort: 20,
      status: 'draft',
    });
    expect(await repository.getModel(alpha.id, b.id)).toMatchObject({
      sort: 10,
      status: 'draft',
    });
    expect(await repository.getModel(beta.id, foreign.id)).toMatchObject({
      sort: 1,
      status: 'draft',
    });
  });

  it('hard-deletes a provider with its models, revision history, and cascaded secrets', async () => {
    const alpha = await repository.createProvider({ displayName: 'Alpha', providerKey: 'alpha' });
    const beta = await repository.createProvider({ displayName: 'Beta', providerKey: 'beta' });
    await repository.createModel({ modelKey: 'chat', providerId: alpha.id });
    await repository.createModel({ modelKey: 'image', providerId: alpha.id });
    await repository.createModel({ modelKey: 'chat', providerId: beta.id });
    await serverDB.insert(platformAiProviderSecrets).values({
      ciphertext: 'cipher',
      fingerprint: 'fp-alpha',
      providerId: alpha.id,
    });
    const payload = { models: [], provider: { providerKey: 'alpha' } };
    await serverDB.insert(platformResourceRevisions).values([
      {
        checksum: checksumPayload(payload),
        payload,
        resourceId: alpha.id,
        resourceType: 'provider',
        revision: 1,
        status: 'published',
      },
      {
        checksum: checksumPayload(payload),
        payload,
        resourceId: beta.id,
        resourceType: 'provider',
        revision: 1,
        status: 'published',
      },
    ]);

    expect(await repository.deleteProviderModels(alpha.id)).toBe(2);
    // Revision rows are append-only, but a provider hard-delete purges its own history via
    // the transaction-local opt-in GUC (migration 0012) — nothing of the provider survives.
    expect(await repository.deleteProviderRevisions(alpha.id)).toBe(1);
    expect(await repository.deleteProvider(alpha.id)).toMatchObject({ id: alpha.id });

    // Everything belonging to Alpha is gone; Beta (including its revision) is untouched.
    expect(await repository.getProvider(alpha.id)).toBeUndefined();
    expect(await repository.listModels(alpha.id)).toHaveLength(0);
    expect(
      await serverDB
        .select()
        .from(platformAiProviderSecrets)
        .where(eq(platformAiProviderSecrets.providerId, alpha.id)),
    ).toHaveLength(0);
    expect(
      await serverDB
        .select()
        .from(platformResourceRevisions)
        .where(eq(platformResourceRevisions.resourceId, alpha.id)),
    ).toHaveLength(0);
    expect(await repository.getProvider(beta.id)).toMatchObject({ id: beta.id });
    expect(await repository.listModels(beta.id)).toHaveLength(1);
    expect(
      await serverDB
        .select()
        .from(platformResourceRevisions)
        .where(eq(platformResourceRevisions.resourceId, beta.id)),
    ).toHaveLength(1);
  });

  it('disarms the revision purge opt-in again once the purge statement is done', async () => {
    // SET LOCAL survives RELEASE SAVEPOINT, so an un-restored opt-in would stay armed for the
    // rest of the caller's transaction and let an unrelated revision DELETE slip past the
    // trigger. The purge must leave the permission exactly as it found it.
    const alpha = await repository.createProvider({ displayName: 'Alpha', providerKey: 'alpha' });
    const payload = { models: [], provider: { providerKey: 'alpha' } };
    await serverDB.insert(platformResourceRevisions).values([
      {
        checksum: checksumPayload(payload),
        payload,
        resourceId: alpha.id,
        resourceType: 'provider',
        revision: 1,
        status: 'published',
      },
      {
        checksum: checksumPayload(payload),
        id: 'rev-sibling-protected',
        payload,
        resourceId: 'unrelated-resource',
        resourceType: 'settings',
        revision: 1,
        status: 'published',
      },
    ]);

    let siblingDeleteError: unknown;
    await serverDB.transaction(async (tx) => {
      expect(await new PlatformAiCatalogRepository(tx).deleteProviderRevisions(alpha.id)).toBe(1);
      // Savepoint so the rejected sibling DELETE does not abort the parent transaction —
      // the purge itself must still commit.
      try {
        await tx.transaction(async (sibling) => {
          await sibling
            .delete(platformResourceRevisions)
            .where(eq(platformResourceRevisions.id, 'rev-sibling-protected'));
        });
      } catch (error) {
        siblingDeleteError = error;
      }
    });

    const err = siblingDeleteError as (Error & { cause?: Error }) | undefined;
    expect(`${err?.message ?? ''}\n${err?.cause?.message ?? ''}`).toMatch(/immutable/i);
    // Purge committed; the unrelated revision survived because the opt-in was disarmed.
    expect(
      await serverDB.select({ id: platformResourceRevisions.id }).from(platformResourceRevisions),
    ).toEqual([{ id: 'rev-sibling-protected' }]);
  });

  it('batch-loads providers and models in single-query helpers', async () => {
    const alpha = await repository.createProvider({ displayName: 'Alpha', providerKey: 'alpha' });
    const beta = await repository.createProvider({ displayName: 'Beta', providerKey: 'beta' });
    await repository.createModel({ modelKey: 'm-a', providerId: alpha.id, sort: 0 });
    await repository.createModel({ modelKey: 'm-b1', providerId: beta.id, sort: 0 });
    await repository.createModel({ modelKey: 'm-b2', providerId: beta.id, sort: 1 });

    const byIds = await repository.getProvidersByIds([alpha.id, beta.id, 'missing-id']);
    expect(byIds.map((p) => p.providerKey).sort()).toEqual(['alpha', 'beta']);

    const byKeys = await repository.getProvidersByKeys(['alpha', 'missing-key', 'beta']);
    expect(byKeys.map((p) => p.id).sort()).toEqual([alpha.id, beta.id].sort());

    const models = await repository.listModelsForProviders([alpha.id, beta.id]);
    expect(models).toHaveLength(3);
    expect(models.filter((m) => m.providerId === beta.id).map((m) => m.modelKey)).toEqual([
      'm-b1',
      'm-b2',
    ]);
    expect(await repository.listModelsForProviders([])).toEqual([]);
  });

  describe('casProviderSecretCiphertext', () => {
    it('CAS-updates the secret version and syncs the provider when fingerprint+ciphertext match', async () => {
      const provider = await repository.createProvider({
        displayName: 'Alpha',
        providerKey: 'alpha',
      });
      await repository.storeProviderSecretVersion({
        ciphertext: 'cipher-v1',
        fingerprint: 'fp-1',
        keyId: 'key-v1',
        keyVersion: 1,
        providerId: provider.id,
      });
      await repository.updateProvider(provider.id, {
        encryptedKeyVaults: 'cipher-v1',
        secretFingerprint: 'fp-1',
        secretKeyId: 'key-v1',
      });

      const result = await repository.casProviderSecretCiphertext({
        ciphertext: 'cipher-v2',
        expectedCiphertext: 'cipher-v1',
        fingerprint: 'fp-1',
        keyId: 'key-v2',
        providerId: provider.id,
      });

      expect(result).toBe(true);
      expect(await repository.getProviderSecretVersion(provider.id, 'fp-1')).toMatchObject({
        ciphertext: 'cipher-v2',
        keyId: 'key-v2',
      });
      const synced = await repository.getProvider(provider.id);
      expect(synced).toMatchObject({
        encryptedKeyVaults: 'cipher-v2',
        secretFingerprint: 'fp-1',
        secretKeyId: 'key-v2',
      });
      expect(synced!.secretUpdatedAt).not.toBeNull();
    });

    it('returns false and changes nothing when expectedCiphertext is stale', async () => {
      const provider = await repository.createProvider({
        displayName: 'Alpha',
        providerKey: 'alpha',
      });
      await repository.storeProviderSecretVersion({
        ciphertext: 'cipher-v1',
        fingerprint: 'fp-1',
        keyId: 'key-v1',
        keyVersion: 1,
        providerId: provider.id,
      });
      await repository.updateProvider(provider.id, {
        encryptedKeyVaults: 'cipher-v1',
        secretFingerprint: 'fp-1',
        secretKeyId: 'key-v1',
      });

      const result = await repository.casProviderSecretCiphertext({
        ciphertext: 'cipher-v2',
        expectedCiphertext: 'cipher-stale',
        fingerprint: 'fp-1',
        keyId: 'key-v2',
        providerId: provider.id,
      });

      expect(result).toBe(false);
      expect(await repository.getProviderSecretVersion(provider.id, 'fp-1')).toMatchObject({
        ciphertext: 'cipher-v1',
        keyId: 'key-v1',
      });
      expect(await repository.getProvider(provider.id)).toMatchObject({
        encryptedKeyVaults: 'cipher-v1',
        secretKeyId: 'key-v1',
      });
    });

    it('does not sync the provider when its secret_fingerprint no longer matches (admin replaced the secret)', async () => {
      const provider = await repository.createProvider({
        displayName: 'Alpha',
        providerKey: 'alpha',
      });
      // Stale rotation target: an older secret version at fp-old, still stored.
      await repository.storeProviderSecretVersion({
        ciphertext: 'cipher-old',
        fingerprint: 'fp-old',
        keyId: 'key-old',
        keyVersion: 1,
        providerId: provider.id,
      });
      // Admin has since replaced the secret with a fresh fingerprint.
      await repository.updateProvider(provider.id, {
        encryptedKeyVaults: 'cipher-new',
        secretFingerprint: 'fp-new',
        secretKeyId: 'key-new',
      });

      const result = await repository.casProviderSecretCiphertext({
        ciphertext: 'cipher-old-rotated',
        expectedCiphertext: 'cipher-old',
        fingerprint: 'fp-old',
        keyId: 'key-old-rotated',
        providerId: provider.id,
      });

      expect(result).toBe(true);
      expect(await repository.getProviderSecretVersion(provider.id, 'fp-old')).toMatchObject({
        ciphertext: 'cipher-old-rotated',
        keyId: 'key-old-rotated',
      });
      // Provider row still points at the admin-replaced secret, untouched.
      expect(await repository.getProvider(provider.id)).toMatchObject({
        encryptedKeyVaults: 'cipher-new',
        secretFingerprint: 'fp-new',
        secretKeyId: 'key-new',
      });
    });

    it('does not sync the provider when fingerprint matches but encrypted_key_vaults differs from expectedCiphertext', async () => {
      const provider = await repository.createProvider({
        displayName: 'Alpha',
        providerKey: 'alpha',
      });
      await repository.storeProviderSecretVersion({
        ciphertext: 'cipher-v1',
        fingerprint: 'fp-1',
        keyId: 'key-v1',
        keyVersion: 1,
        providerId: provider.id,
      });
      // Provider points at the right fingerprint but a different ciphertext value
      // than the one we're about to CAS-rotate (e.g. a concurrent write raced in).
      await repository.updateProvider(provider.id, {
        encryptedKeyVaults: 'cipher-divergent',
        secretFingerprint: 'fp-1',
        secretKeyId: 'key-divergent',
      });

      const result = await repository.casProviderSecretCiphertext({
        ciphertext: 'cipher-v2',
        expectedCiphertext: 'cipher-v1',
        fingerprint: 'fp-1',
        keyId: 'key-v2',
        providerId: provider.id,
      });

      expect(result).toBe(true);
      expect(await repository.getProviderSecretVersion(provider.id, 'fp-1')).toMatchObject({
        ciphertext: 'cipher-v2',
        keyId: 'key-v2',
      });
      expect(await repository.getProvider(provider.id)).toMatchObject({
        encryptedKeyVaults: 'cipher-divergent',
        secretFingerprint: 'fp-1',
        secretKeyId: 'key-divergent',
      });
    });

    it('returns false for a wrong fingerprint or a wrong providerId', async () => {
      const alpha = await repository.createProvider({ displayName: 'Alpha', providerKey: 'alpha' });
      const beta = await repository.createProvider({ displayName: 'Beta', providerKey: 'beta' });
      await repository.storeProviderSecretVersion({
        ciphertext: 'cipher-v1',
        fingerprint: 'fp-1',
        keyId: 'key-v1',
        keyVersion: 1,
        providerId: alpha.id,
      });
      await repository.updateProvider(alpha.id, {
        encryptedKeyVaults: 'cipher-v1',
        secretFingerprint: 'fp-1',
        secretKeyId: 'key-v1',
      });

      expect(
        await repository.casProviderSecretCiphertext({
          ciphertext: 'cipher-v2',
          expectedCiphertext: 'cipher-v1',
          fingerprint: 'fp-wrong',
          keyId: 'key-v2',
          providerId: alpha.id,
        }),
      ).toBe(false);
      expect(
        await repository.casProviderSecretCiphertext({
          ciphertext: 'cipher-v2',
          expectedCiphertext: 'cipher-v1',
          fingerprint: 'fp-1',
          keyId: 'key-v2',
          providerId: beta.id,
        }),
      ).toBe(false);

      expect(await repository.getProviderSecretVersion(alpha.id, 'fp-1')).toMatchObject({
        ciphertext: 'cipher-v1',
        keyId: 'key-v1',
      });
      expect(await repository.getProvider(alpha.id)).toMatchObject({
        encryptedKeyVaults: 'cipher-v1',
        secretKeyId: 'key-v1',
      });
    });
  });
});
