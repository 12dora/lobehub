// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviderInstances,
  platformIdentityProviders,
  platformInstanceHeartbeats,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import {
  getIdentityProviderProcessInstance,
  registerIdentityProviderInstance,
  stopIdentityProviderHeartbeatForTest,
} from './instanceRegistry';

const db: LobeChatDatabase = await getTestDB();
const snapshot = {
  databaseProviders: [],
  generation: null,
  health: 'healthy' as const,
  identityRevision: null,
  lastError: null,
  loadedAt: new Date(),
  providerIds: [],
  source: 'environment' as const,
};

beforeEach(async () => {
  stopIdentityProviderHeartbeatForTest();
  await db.delete(platformIdentityProviderInstances);
  await db.delete(platformIdentityProviders);
  await db.delete(platformInstanceHeartbeats);
  // This suite does not insert revisions; empty resourceIds is an explicit no-op (SG-07).
  await deletePlatformResourceRevisionsForTest(db, { resourceIds: [] });
});

afterEach(async () => {
  stopIdentityProviderHeartbeatForTest();
  const { resetPlatformInstanceHeartbeatForTest } =
    await import('../platformInstance/heartbeatRuntime');
  resetPlatformInstanceHeartbeatForTest();
  vi.restoreAllMocks();
});

describe('identity provider process ownership', () => {
  it('keeps one instance identity and heartbeat owner across duplicate module evaluation', async () => {
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const firstIdentity = getIdentityProviderProcessInstance();
    await registerIdentityProviderInstance({ db, env: {}, snapshot });

    vi.resetModules();
    const duplicateChunk = await import('./instanceRegistry');
    expect(duplicateChunk.getIdentityProviderProcessInstance()).toEqual(firstIdentity);
    await duplicateChunk.registerIdentityProviderInstance({ db, env: {}, snapshot });

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    duplicateChunk.stopIdentityProviderHeartbeatForTest();
  });

  it('clears the fallback timer when the platform ticker starts', async () => {
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    await registerIdentityProviderInstance({ db, env: {}, snapshot });

    const { ensurePlatformInstanceHeartbeatStarted } =
      await import('../platformInstance/heartbeatRuntime');
    await ensurePlatformInstanceHeartbeatStarted({
      createRepository: () => ({
        registerInstance: vi.fn().mockResolvedValue({
          instanceId: 'pinst_test',
          lastHeartbeatAt: new Date(),
          startedAt: new Date(),
        }),
        upsertHeartbeat: vi.fn().mockResolvedValue({
          instanceId: 'pinst_test',
          lastHeartbeatAt: new Date(),
          startedAt: new Date(),
        }),
      }),
      env: {
        DATABASE_URL: 'postgresql://database.invalid/lobehub',
        ENABLE_PLATFORM_ADMIN: '1',
        NODE_ENV: 'production',
      },
      getDatabase: async () =>
        ({
          transaction: async (fn: (tx: LobeChatDatabase) => Promise<unknown>) =>
            fn({} as LobeChatDatabase),
        }) as unknown as LobeChatDatabase,
      schedule: () => ({ clear: vi.fn(), unref: vi.fn() }),
    });

    expect(clearSpy).toHaveBeenCalledWith(timer);
  });

  it('rolls back a listener write after lastHeartbeat when the listener throws', async () => {
    await registerIdentityProviderInstance({ db, env: {}, snapshot });
    const { instanceId } = getIdentityProviderProcessInstance();
    const before = await db.query.platformIdentityProviderInstances.findFirst({
      where: eq(platformIdentityProviderInstances.instanceId, instanceId),
    });
    expect(before).toBeDefined();
    stopIdentityProviderHeartbeatForTest();

    const {
      ensurePlatformInstanceHeartbeatStarted,
      getPlatformInstanceId,
      onPlatformInstanceHeartbeatTick,
    } = await import('../platformInstance/heartbeatRuntime');

    const sentinel = new Date('2099-06-01T00:00:00.000Z');
    onPlatformInstanceHeartbeatTick(async (tx) => {
      await tx
        .update(platformIdentityProviderInstances)
        .set({ lastHeartbeat: sentinel })
        .where(eq(platformIdentityProviderInstances.instanceId, instanceId));
      throw new TypeError('after lastHeartbeat');
    });

    let tick: (() => void) | undefined;
    await ensurePlatformInstanceHeartbeatStarted({
      env: {
        DATABASE_URL: 'postgresql://database.invalid/lobehub',
        ENABLE_PLATFORM_ADMIN: '1',
        NODE_ENV: 'production',
      },
      getDatabase: async () => db,
      schedule: (callback) => {
        tick = callback;
        return { clear: vi.fn(), unref: vi.fn() };
      },
    });

    tick?.();
    const platformId = getPlatformInstanceId();
    await vi.waitFor(async () => {
      const row = await db.query.platformInstanceHeartbeats.findFirst({
        where: eq(platformInstanceHeartbeats.instanceId, platformId),
      });
      expect(row).toBeDefined();
    });

    const after = await db.query.platformIdentityProviderInstances.findFirst({
      where: eq(platformIdentityProviderInstances.instanceId, instanceId),
    });
    expect(after?.lastHeartbeat.getTime()).not.toBe(sentinel.getTime());
    expect(after?.lastHeartbeat.getTime()).toBe(before!.lastHeartbeat.getTime());
  });
});
