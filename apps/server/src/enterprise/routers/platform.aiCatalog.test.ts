// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  platformAiModels,
  platformAiProviders,
  platformResourceRevisions,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { platformRouter } from './platform';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(platformRouter);
const userId = 'm07-platform-catalog-user';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await db.delete(platformResourceRevisions);
  await db.delete(platformAiModels);
  await db.delete(platformAiProviders);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
  await db.insert(users).values({ id: userId });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('platform.aiCatalog.getPublished flag gate', () => {
  it('returns a stable empty catalog when managed AI is off despite residual revisions', async () => {
    const [provider] = await db
      .insert(platformAiProviders)
      .values({ displayName: 'Residual', providerKey: 'residual' })
      .returning();
    const payload = {
      models: [{ enabled: true, modelKey: 'secret-residual-model' }],
      provider: {
        displayName: 'Residual',
        enabled: true,
        providerKey: 'residual',
      },
    };
    await db.insert(platformResourceRevisions).values({
      checksum: checksumPayload(payload),
      payload,
      resourceId: provider.id,
      resourceType: 'provider',
      revision: 1,
      status: 'published',
    });

    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '0');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    const first = await caller.aiCatalog.getPublished();
    const second = await caller.aiCatalog.getPublished();
    expect(first).toEqual(second);
    expect(first.providers).toEqual([]);
    expect(JSON.stringify(first)).not.toContain('residual');
  });

  it('returns published picker metadata when managed AI is on', async () => {
    const [provider] = await db
      .insert(platformAiProviders)
      .values({ displayName: 'Alpha', providerKey: 'alpha' })
      .returning();
    const payload = {
      models: [{ enabled: true, modelKey: 'chat', sort: 0, type: 'chat' }],
      provider: {
        displayName: 'Alpha',
        enabled: true,
        providerKey: 'alpha',
        sort: 0,
        source: 'custom',
      },
    };
    await db.insert(platformResourceRevisions).values({
      checksum: checksumPayload(payload),
      payload,
      resourceId: provider.id,
      resourceType: 'provider',
      revision: 1,
      status: 'published',
    });
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    await expect(caller.aiCatalog.getPublished()).resolves.toMatchObject({
      providers: [{ models: [{ modelKey: 'chat' }], providerKey: 'alpha' }],
    });
  });
});
