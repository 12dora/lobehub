// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviderInstances,
  platformIdentityProviders,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

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
  await db.delete(platformResourceRevisions);
});

afterEach(() => {
  stopIdentityProviderHeartbeatForTest();
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
});
