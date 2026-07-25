import { afterEach, describe, expect, it } from 'vitest';

import {
  ADMIN_STATS_USER_DISPLAY_CACHE_MAX,
  getAdminStatsUserDisplayCacheSize,
  rememberUsersFromUsage,
  resetAdminStatsUserDisplayCache,
  resolveAdminStatsUser,
} from './adminStatsDataSource';

describe('adminStatsDataSource user display cache', () => {
  afterEach(() => {
    resetAdminStatsUserDisplayCache();
  });

  it('updates an existing display name when a later row renames the user', () => {
    rememberUsersFromUsage([{ userDisplay: 'Alice', userId: 'u1' }]);
    expect(resolveAdminStatsUser('u1')).toEqual({ avatar: null, name: 'Alice' });

    rememberUsersFromUsage([{ userDisplay: 'Alice Smith', userId: 'u1' }]);
    expect(resolveAdminStatsUser('u1')).toEqual({ avatar: null, name: 'Alice Smith' });
  });

  it('does not grow without bound past the LRU cap', () => {
    for (let i = 0; i < ADMIN_STATS_USER_DISPLAY_CACHE_MAX + 50; i += 1) {
      rememberUsersFromUsage([{ userDisplay: `User ${i}`, userId: `u-${i}` }]);
    }
    expect(getAdminStatsUserDisplayCacheSize()).toBe(ADMIN_STATS_USER_DISPLAY_CACHE_MAX);

    // Oldest entries are evicted.
    expect(resolveAdminStatsUser('u-0')).toEqual({ avatar: null, name: 'u-0' });
    // Newest entries remain.
    const last = ADMIN_STATS_USER_DISPLAY_CACHE_MAX + 49;
    expect(resolveAdminStatsUser(`u-${last}`)).toEqual({
      avatar: null,
      name: `User ${last}`,
    });
  });

  it('reset clears the cache for account/scope transitions', () => {
    rememberUsersFromUsage([{ userDisplay: 'Alice', userId: 'u1' }]);
    resetAdminStatsUserDisplayCache();
    expect(getAdminStatsUserDisplayCacheSize()).toBe(0);
    expect(resolveAdminStatsUser('u1')).toEqual({ avatar: null, name: 'u1' });
  });
});
