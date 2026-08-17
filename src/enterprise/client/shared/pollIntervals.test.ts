import { describe, expect, it } from 'vitest';

import { AUDIT_LIST_POLL_MS } from '@/enterprise/client/features/admin/audit/shared/useCursorPagination';
import { NETWORK_PROXY_STATUS_REFRESH_MS } from '@/enterprise/client/features/admin/networkProxy/hooks';
import {
  PLATFORM_CAPABILITIES_REFRESH_INTERVAL,
  PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL,
} from '@/enterprise/client/providers/useEnterprisePlatformData';

import { ADMIN_POLL_INTERVALS } from './pollIntervals';

describe('ADMIN_POLL_INTERVALS', () => {
  it('is the single source for the per-feature poll cadences', () => {
    expect(AUDIT_LIST_POLL_MS).toBe(ADMIN_POLL_INTERVALS.auditList);
    expect(NETWORK_PROXY_STATUS_REFRESH_MS).toBe(ADMIN_POLL_INTERVALS.networkProxyStatus);
  });

  /** The provider now derives its two exports from the table; this pins the wiring. */
  it('is what the provider layer’s cadences are derived from', () => {
    expect(PLATFORM_PUBLIC_SNAPSHOT_REFRESH_INTERVAL).toBe(ADMIN_POLL_INTERVALS.publicSnapshot);
    expect(PLATFORM_CAPABILITIES_REFRESH_INTERVAL).toBe(ADMIN_POLL_INTERVALS.capabilities);
  });

  it('keeps the anonymous-visitor poll the slowest of the always-on ones', () => {
    expect(ADMIN_POLL_INTERVALS.publicSnapshot).toBeGreaterThanOrEqual(
      ADMIN_POLL_INTERVALS.networkProxyStatus,
    );
    expect(ADMIN_POLL_INTERVALS.capabilities).toBeGreaterThanOrEqual(
      ADMIN_POLL_INTERVALS.publicSnapshot,
    );
  });

  /**
   * Both polls are started by the same hook in the same render, so equal cadences keep their
   * timers in lockstep and the tRPC batch link folds the pair into ONE request per tick. Splitting
   * them doubles the idle request count of every open tab.
   */
  it('keeps the two platform-wide polls in lockstep so they batch into one request', () => {
    expect(ADMIN_POLL_INTERVALS.capabilities).toBe(ADMIN_POLL_INTERVALS.publicSnapshot);
  });

  /** HANDOFF P6 budget: an idle tab spends ≤3 requests per poll in five minutes. */
  it('keeps an idle five-minute window under three ticks per platform-wide poll', () => {
    const fiveMinutes = 5 * 60 * 1000;
    for (const key of ['capabilities', 'publicSnapshot'] as const) {
      expect(Math.floor(fiveMinutes / ADMIN_POLL_INTERVALS[key]) + 1, key).toBeLessThanOrEqual(3);
    }
  });

  it('never polls faster than once a second', () => {
    for (const [name, value] of Object.entries(ADMIN_POLL_INTERVALS)) {
      expect(value, name).toBeGreaterThanOrEqual(1000);
    }
  });
});
