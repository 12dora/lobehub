// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';
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

import { getEnterpriseErrorBody } from '../guards/enterpriseErrors';
import { deletePlatformResourceRevisionsForTest } from '../testing/deletePlatformResourceRevisions';
import { platformRouter } from './platform';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(platformRouter);
const userId = 'm07-platform-catalog-user';
const IDS = {
  banned: 'm07-platform-catalog-banned',
  epoch: 'm07-platform-catalog-epoch',
  tempBanned: 'm07-platform-catalog-temp-banned',
} as const;

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  const ownedProviders = await db.select({ id: platformAiProviders.id }).from(platformAiProviders);
  await deletePlatformResourceRevisionsForTest(db, {
    resourceIds: ownedProviders.map((row) => row.id),
    resourceType: 'provider',
  });
  await db.delete(platformAiModels);
  await db.delete(platformAiProviders);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
  await db
    .insert(users)
    .values([
      { id: userId },
      { banned: true, id: IDS.banned },
      { banExpires: new Date(Date.now() + 3_600_000), banned: true, id: IDS.tempBanned },
      { authInvalidatedAt: new Date('2021-01-01T00:00:00.000Z'), id: IDS.epoch },
    ]);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('platform.aiCatalog.getPublished flag gate', () => {
  it('returns a stable empty catalog when managed AI is off despite residual revisions', async () => {
    const [provider] = await db
      .insert(platformAiProviders)
      .values({
        displayName: 'Residual',
        providerKey: 'residual',
        revision: 1,
        status: 'published',
      })
      .returning();
    const payload = {
      models: [{ enabled: true, modelKey: 'secret-residual-model', type: 'chat' }],
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
    // Snapshot authority joins provider.revision → matching published revision row.
    const [provider] = await db
      .insert(platformAiProviders)
      .values({
        displayName: 'Alpha',
        providerKey: 'alpha',
        revision: 1,
        status: 'published',
      })
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

describe('managed AI catalog rejects banned, temporary-banned, and epoch-invalid principals', () => {
  const expectAccessDenied = (error: unknown) => {
    const body = getEnterpriseErrorBody(error);
    expect(
      body?.code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED ||
        (error as { code?: string }).code === 'UNAUTHORIZED',
    ).toBe(true);
  };

  const callerFor = async (
    id: string,
    extras?: { authMethod?: 'better-auth' | 'oidc'; credentialIssuedAt?: Date },
  ) =>
    createCaller({
      ...(await createContextInner({
        authMethod: extras?.authMethod ?? 'oidc',
        credentialIssuedAt: extras?.credentialIssuedAt ?? new Date('2020-01-01T00:00:00.000Z'),
        userId: id,
      })),
      serverDB: db,
    } as never);

  beforeEach(() => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1');
  });

  it('rejects a banned caller before catalog access', async () => {
    const caller = await callerFor(IDS.banned);
    try {
      await caller.aiCatalog.getPublished();
      expect.fail('expected banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }
  });

  it('rejects a temporarily-banned caller before catalog access', async () => {
    const caller = await callerFor(IDS.tempBanned);
    try {
      await caller.aiCatalog.getPublished();
      expect.fail('expected temp-banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }
  });

  it('rejects an epoch-invalidated caller before catalog access', async () => {
    const caller = await callerFor(IDS.epoch, { authMethod: 'oidc' });
    try {
      await caller.aiCatalog.getPublished();
      expect.fail('expected epoch-invalid caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }
  });
});
