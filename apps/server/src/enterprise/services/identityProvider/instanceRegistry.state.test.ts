// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformIdentityProviderInstances,
  platformIdentityProviders,
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
  // This suite does not insert revisions; empty resourceIds is an explicit no-op (SG-07).
  await deletePlatformResourceRevisionsForTest(db, { resourceIds: [] });
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
