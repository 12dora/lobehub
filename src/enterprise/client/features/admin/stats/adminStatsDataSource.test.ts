import { afterEach, describe, expect, it, vi } from 'vitest';

import { adminStatsService } from '@/enterprise/client/services/adminStats';

import {
  ADMIN_STATS_USER_DISPLAY_CACHE_MAX,
  adminGlobalStatsDataSource,
  getAdminStatsCurrentUserDisplaySize,
  getAdminStatsUserDisplayCacheSize,
  rememberCurrentUsersFromUsage,
  resetAdminStatsUserDisplayCache,
  resolveAdminStatsUser,
} from './adminStatsDataSource';

vi.mock('@/enterprise/client/services/adminStats', () => ({
  adminStatsService: {
    rankTopics: vi.fn(),
  },
}));

const unknownUserLabel = (index: number) => `Unknown user ${index}`;

describe('adminStatsDataSource user display cache', () => {
  afterEach(() => {
    resetAdminStatsUserDisplayCache();
  });

  it('updates an existing display name when a later row renames the user', () => {
    rememberCurrentUsersFromUsage([{ userDisplay: 'Alice', userId: 'u1' }]);
    expect(resolveAdminStatsUser('u1', unknownUserLabel)).toEqual({
      avatar: null,
      name: 'Alice',
    });

    rememberCurrentUsersFromUsage([{ userDisplay: 'Alice Smith', userId: 'u1' }]);
    expect(resolveAdminStatsUser('u1', unknownUserLabel)).toEqual({
      avatar: null,
      name: 'Alice Smith',
    });
  });

  it('retains every display name from a current response larger than the history cap', () => {
    const records = Array.from({ length: ADMIN_STATS_USER_DISPLAY_CACHE_MAX + 50 }, (_, index) => ({
      userDisplay: `User ${index}`,
      userId: `u-${index}`,
    }));
    rememberCurrentUsersFromUsage(records);

    expect(getAdminStatsCurrentUserDisplaySize()).toBe(records.length);
    expect(getAdminStatsUserDisplayCacheSize()).toBe(ADMIN_STATS_USER_DISPLAY_CACHE_MAX);
    for (let index = 0; index < records.length; index += 1) {
      expect(resolveAdminStatsUser(`u-${index}`, unknownUserLabel)).toEqual({
        avatar: null,
        name: `User ${index}`,
      });
    }

    // Replacing the active response proves the auxiliary historical cache remains bounded.
    rememberCurrentUsersFromUsage([]);
    expect(resolveAdminStatsUser('u-0', unknownUserLabel)).toEqual({
      avatar: null,
      name: 'Unknown user 1',
    });
    expect(resolveAdminStatsUser(`u-${records.length - 1}`, unknownUserLabel)).toEqual({
      avatar: null,
      name: `User ${records.length - 1}`,
    });
  });

  it('uses stable localized aliases instead of exposing raw IDs', () => {
    rememberCurrentUsersFromUsage([{ userId: 'internal-uuid-a' }, { userId: 'internal-uuid-b' }]);

    expect(resolveAdminStatsUser('internal-uuid-a', unknownUserLabel).name).toBe('Unknown user 1');
    expect(resolveAdminStatsUser('internal-uuid-b', unknownUserLabel).name).toBe('Unknown user 2');
    expect(resolveAdminStatsUser('internal-uuid-a', unknownUserLabel).name).toBe('Unknown user 1');
  });

  it('reset clears the cache for account/scope transitions', () => {
    rememberCurrentUsersFromUsage([{ userDisplay: 'Alice', userId: 'u1' }]);
    resetAdminStatsUserDisplayCache();
    expect(getAdminStatsUserDisplayCacheSize()).toBe(0);
    expect(getAdminStatsCurrentUserDisplaySize()).toBe(0);
    expect(resolveAdminStatsUser('u1', unknownUserLabel)).toEqual({
      avatar: null,
      name: 'Unknown user 1',
    });
  });
});

describe('adminGlobalStatsDataSource.rankTopics', () => {
  afterEach(() => {
    vi.mocked(adminStatsService.rankTopics).mockReset();
  });

  it('unwraps the policy envelope into ranked items', async () => {
    const items = [
      { agentId: 'agt-1', count: 3, id: 'topic-1', title: 'Secret chat', userId: 'u-other' },
    ];
    vi.mocked(adminStatsService.rankTopics).mockResolvedValue({
      contentAccessMode: 'metadata_only',
      items,
    });

    await expect(adminGlobalStatsDataSource.rankTopics(5, { userId: 'u-other' })).resolves.toEqual(
      items,
    );
    expect(adminStatsService.rankTopics).toHaveBeenCalledWith(5, { userId: 'u-other' });
  });

  it('propagates a disabled-policy rejection', async () => {
    const error = Object.assign(new Error('Audit conversation content access is disabled'), {
      code: 'FORBIDDEN',
    });
    vi.mocked(adminStatsService.rankTopics).mockRejectedValue(error);

    await expect(adminGlobalStatsDataSource.rankTopics()).rejects.toBe(error);
  });
});
