'use client';

import { useCallback, useRef, useState } from 'react';
import type { KeyedMutator } from 'swr';

import type { AdminAgentDetailOutput } from './types';

export interface RefreshLock {
  /** Ref-based check (no stale closures) — true while a committed change awaits a successful refresh. */
  isLocked: () => boolean;
  /** Reactive flag for disabling controls + showing the "saved, refresh required" banner. */
  refreshFailed: boolean;
  /** Retry the detail refresh; unlocks on success, stays locked on failure. */
  retryRefresh: () => Promise<void>;
  /**
   * Call after a committed mutation whose output cannot advance the local CAS. Revalidates the
   * detail; on failure it LOCKS every dependent write (agent + assignment) until an explicit
   * refresh succeeds, so a stale-CAS second mutation can never fire.
   */
  syncAfterCommit: () => Promise<void>;
}

/**
 * Shared refresh gate for one Agent detail surface. A committed mutation followed by a failed
 * detail refresh must not read as a save failure, must not clear recovery, and must block ALL
 * further dangerous/agent/assignment writes on the now-stale snapshot until refresh succeeds.
 */
export const useRefreshLock = (mutate: KeyedMutator<AdminAgentDetailOutput>): RefreshLock => {
  const [refreshFailed, setRefreshFailed] = useState(false);
  const lockedRef = useRef(false);

  const sync = useCallback(async () => {
    try {
      await mutate();
      lockedRef.current = false;
      setRefreshFailed(false);
    } catch {
      // Committed already — surface a distinct refresh-required state and lock writes.
      lockedRef.current = true;
      setRefreshFailed(true);
    }
  }, [mutate]);

  const isLocked = useCallback(() => lockedRef.current, []);

  return { isLocked, refreshFailed, retryRefresh: sync, syncAfterCommit: sync };
};
