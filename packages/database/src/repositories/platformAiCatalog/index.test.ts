// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { checksumPayload } from '../../models/platform/checksum';
import {
  platformAiModels,
  platformAiProviders,
  platformResourceRevisions,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAiCatalogRepository } from '.';

const serverDB: LobeChatDatabase = await getTestDB();
const repository = new PlatformAiCatalogRepository(serverDB);

const cleanup = async () => {
  await serverDB
    .delete(platformResourceRevisions)
    .where(eq(platformResourceRevisions.resourceType, 'provider'));
  await serverDB.delete(platformAiModels);
  await serverDB.delete(platformAiProviders);
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

  it('returns only the latest published revision per provider', async () => {
    const alpha = await repository.createProvider({ displayName: 'Alpha', providerKey: 'alpha' });
    const beta = await repository.createProvider({ displayName: 'Beta', providerKey: 'beta' });
    const insertRevision = async (params: {
      providerId: string;
      providerKey: string;
      revision: number;
      status: 'draft' | 'published';
    }) => {
      const payload = { models: [], provider: { providerKey: params.providerKey } };
      await serverDB.insert(platformResourceRevisions).values({
        checksum: checksumPayload(payload),
        payload,
        resourceId: params.providerId,
        resourceType: 'provider',
        revision: params.revision,
        status: params.status,
      });
    };
    await insertRevision({
      providerId: alpha.id,
      providerKey: 'alpha-old',
      revision: 1,
      status: 'published',
    });
    await insertRevision({
      providerId: alpha.id,
      providerKey: 'alpha-draft',
      revision: 2,
      status: 'draft',
    });
    await insertRevision({
      providerId: alpha.id,
      providerKey: 'alpha-new',
      revision: 3,
      status: 'published',
    });
    await insertRevision({
      providerId: beta.id,
      providerKey: 'beta',
      revision: 1,
      status: 'published',
    });

    const rows = await repository.listLatestPublishedProviderRevisions();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.resourceId, row.revision])).toEqual(
      expect.arrayContaining([
        [alpha.id, 3],
        [beta.id, 1],
      ]),
    );
  });
});
