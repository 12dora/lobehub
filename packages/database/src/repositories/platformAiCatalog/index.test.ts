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

  it('hard-deletes a provider with its models, revisions, and cascaded secrets', async () => {
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
    // Revisions are immutable — hard-delete is a no-op that retains audit history.
    expect(await repository.deleteProviderRevisions(alpha.id)).toBe(0);
    expect(await repository.deleteProvider(alpha.id)).toMatchObject({ id: alpha.id });

    // Alpha provider/models/secrets are gone; revision history remains; Beta untouched.
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
    ).toHaveLength(1);
    expect(await repository.getProvider(beta.id)).toMatchObject({ id: beta.id });
    expect(await repository.listModels(beta.id)).toHaveLength(1);
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
});
