// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import {
  platformAgents,
  platformAiModels,
  platformAiProviders,
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService, AiCatalogResourceInUseError } from './adminService';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(29), keyId: 'model-test' }),
  providerId: 'test',
};
const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }));

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformAgents);
  await db.delete(platformSettingPolicies);
  await db.delete(platformAiModels);
  await db.delete(platformAiProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

const createProviderAndModels = async () => {
  const provider = await service.createProviderDraft('admin', {
    displayName: 'Alpha',
    providerKey: 'alpha',
    reason: 'create',
    source: 'custom',
  });
  let detail = await service.getDetail(provider.id);
  const first = await service.createModel('admin', {
    enabled: true,
    expectedDraftToken: detail.draftToken,
    modelKey: 'first',
    providerId: provider.id,
    reason: 'first model',
    sort: 1,
  });
  detail = await service.getDetail(provider.id);
  const second = await service.createModel('admin', {
    enabled: true,
    expectedDraftToken: detail.draftToken,
    modelKey: 'second',
    providerId: provider.id,
    reason: 'second model',
    sort: 2,
  });
  return { first, provider, second };
};

describe('AiCatalogAdminService model mutations', () => {
  it('reorder fails closed unless items exactly equal the complete locked provider collection', async () => {
    const { first, provider, second } = await createProviderAndModels();
    const detail = await service.getDetail(provider.id);

    await expect(
      service.reorderModels('admin', {
        expectedDraftToken: detail.draftToken,
        items: [{ id: first.id, sort: 9 }],
        providerId: provider.id,
        reason: 'incomplete reorder',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(
      (await db.select().from(platformAiModels).orderBy(platformAiModels.modelKey)).map(
        (row) => row.sort,
      ),
    ).toEqual([1, 2]);

    const complete = await service.reorderModels('admin', {
      expectedDraftToken: detail.draftToken,
      items: [
        { id: first.id, sort: 2 },
        { id: second.id, sort: 1 },
      ],
      providerId: provider.id,
      reason: 'complete reorder',
    });
    expect(complete.updated).toBe(2);
    expect(complete.draftToken).toHaveLength(64);
    expect(
      (await db.select().from(platformAiModels).orderBy(platformAiModels.modelKey)).map(
        (row) => row.sort,
      ),
    ).toEqual([2, 1]);
  });

  it('blocks disabling/deleting models referenced by published agents or settings', async () => {
    const { first, provider } = await createProviderAndModels();
    await db.insert(platformAgents).values({
      agentKey: 'default-agent',
      model: first.modelKey,
      provider: provider.providerKey,
      status: 'published',
      title: 'Default agent',
    });
    await db.insert(platformSettingPolicies).values({
      mode: 'locked',
      path: 'defaultAgent.config.model',
      status: 'published',
      value: { model: first.modelKey, provider: provider.providerKey },
      visibility: 'visible',
    });

    const dependents = await service.getDependents(provider.id, first.id);
    expect(dependents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'agent' }),
        expect.objectContaining({ resourceType: 'setting' }),
      ]),
    );
    const detail = await service.getDetail(provider.id);
    await expect(
      service.updateModel('admin', {
        enabled: false,
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: first.id,
        providerId: provider.id,
        reason: 'disable in-use',
      }),
    ).rejects.toBeInstanceOf(AiCatalogResourceInUseError);
    await expect(
      service.deleteModel('admin', {
        expectedDraftToken: detail.draftToken,
        id: first.id,
        providerId: provider.id,
        reason: 'delete in-use',
      }),
    ).rejects.toBeInstanceOf(AiCatalogResourceInUseError);
    expect(
      (await db.select().from(platformAiModels).where(eq(platformAiModels.id, first.id)))[0]
        .enabled,
    ).toBe(true);
  });
});
