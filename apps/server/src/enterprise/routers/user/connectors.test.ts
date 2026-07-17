// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { userConnectorsRouter } from './connectors';

let db: LobeChatDatabase;
const createCaller = createCallerFactory(userConnectorsRouter);

beforeAll(async () => {
  db = await getTestDB();
});

beforeEach(() => {
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '0');
});

afterEach(() => vi.unstubAllEnvs());

const callerFor = async (userId: string) =>
  createCaller({ ...(await createContextInner({ userId })), serverDB: db } as never);

describe('user.connectors router', () => {
  it('preserves upstream behavior when the managed connector flag is off', async () => {
    const caller = await callerFor('m09-router-user-a');
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
    await expect(caller.disconnect({ connectorId: 'connector-1' })).resolves.toEqual({
      disconnected: true,
    });
    await expect(caller.startAuthorization({ connectorId: 'connector-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
  });

  it('rejects every client-supplied identity field at the strict boundary', async () => {
    const caller = await callerFor('m09-router-user-a');
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
