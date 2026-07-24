// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';
import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { userConnectorsRouter } from './connectors';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(userConnectorsRouter);

const listManagedSpy = vi.hoisted(() => vi.fn(async () => ({ items: [], nextCursor: null })));
const disconnectSpy = vi.hoisted(() => vi.fn(async () => ({ disconnected: true as const })));

vi.mock('../../services/connectorCatalog/userOAuthService', () => ({
  UserConnectorOAuthService: class {
    disconnect = disconnectSpy;
    getAuthorizationStatus = vi.fn(async () => ({
      attemptId: 'a'.repeat(32),
      binding: null,
      status: 'invalid' as const,
    }));
    listManaged = listManagedSpy;
    startAuthorization = vi.fn(async () => ({
      attemptId: 'a'.repeat(32),
      authorizationUrl: 'https://example.com',
    }));
  },
}));

vi.mock('../../services/connectorCatalog/oauthRuntime', () => ({
  getConnectorOAuthRuntime: vi.fn(() => ({})),
}));

// serverDatabase middleware always resolves via getServerDB(); pin it to the test DB.
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const IDS = {
  active: 'm09-router-user-a',
  banned: 'm09-router-banned',
  epoch: 'm09-router-epoch',
  tempBanned: 'm09-router-temp-banned',
} as const;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '0');
  await db.delete(users);
  await db
    .insert(users)
    .values([
      { id: IDS.active },
      { banned: true, id: IDS.banned },
      { banExpires: new Date(Date.now() + 3_600_000), banned: true, id: IDS.tempBanned },
      { authInvalidatedAt: new Date('2021-01-01T00:00:00.000Z'), id: IDS.epoch },
    ]);
});

afterEach(async () => {
  await db.delete(users);
  vi.unstubAllEnvs();
});

const callerFor = async (
  userId: string,
  extras?: { authMethod?: 'better-auth' | 'oidc'; credentialIssuedAt?: Date },
) =>
  createCaller({
    ...(await createContextInner({
      authMethod: extras?.authMethod ?? 'oidc',
      credentialIssuedAt: extras?.credentialIssuedAt ?? new Date('2020-01-01T00:00:00.000Z'),
      userId,
    })),
    serverDB: db,
  } as never);

const expectAccessDenied = (error: unknown) => {
  const body = getEnterpriseErrorBody(error);
  expect(
    body?.code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED ||
      (error as { code?: string }).code === 'UNAUTHORIZED',
  ).toBe(true);
};

describe('user.connectors router', () => {
  it('preserves upstream behavior when the managed connector flag is off', async () => {
    const caller = await callerFor(IDS.active);
    await expect(caller.listManaged({ limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(
      caller.getAuthorizationStatus({
        attemptId: 'a'.repeat(32),
        connectorId: 'connector-1',
      }),
    ).resolves.toEqual({ attemptId: 'a'.repeat(32), binding: null, status: 'invalid' });
    // Disconnect still revokes bindings/tokens while the feature is disabled.
    await expect(caller.disconnect({ connectorId: 'connector-1' })).resolves.toEqual({
      disconnected: true,
    });
    expect(disconnectSpy).toHaveBeenCalledWith({ connectorId: 'connector-1' });
    await expect(caller.startAuthorization({ connectorId: 'connector-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
  });

  it('rejects every client-supplied identity field at the strict boundary', async () => {
    const caller = await callerFor(IDS.active);
    await expect(
      caller.getAuthorizationStatus({ connectorId: 'connector-1' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.getAuthorizationStatus({
        attemptId: 'a'.repeat(32),
        connectorId: 'connector-1',
        userId: 'user-b',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.startAuthorization({
        connectorId: 'connector-1',
        remoteAccountId: 'remote-user-b',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('managed Connectors reject banned, temporary-banned, and epoch-invalid principals', () => {
  beforeEach(() => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
  });

  it('rejects a banned caller before service access', async () => {
    const caller = await callerFor(IDS.banned);
    try {
      await caller.listManaged({ limit: 50 });
      expect.fail('expected banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }
    expect(listManagedSpy).not.toHaveBeenCalled();
  });

  it('rejects a temporarily-banned caller before service access', async () => {
    const caller = await callerFor(IDS.tempBanned);
    try {
      await caller.listManaged({ limit: 50 });
      expect.fail('expected temp-banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }
    expect(listManagedSpy).not.toHaveBeenCalled();
  });

  it('rejects an epoch-invalidated caller before service access', async () => {
    const caller = await callerFor(IDS.epoch, { authMethod: 'oidc' });
    try {
      await caller.listManaged({ limit: 50 });
      expect.fail('expected epoch-invalid caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }
    expect(listManagedSpy).not.toHaveBeenCalled();
  });

  it('allows an active caller to reach the service when the flag is on', async () => {
    const caller = await callerFor(IDS.active);
    await expect(caller.listManaged({ limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(listManagedSpy).toHaveBeenCalled();
  });
});
