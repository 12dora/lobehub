'use client';

import { useCallback, useRef, useState } from 'react';

export interface RefreshLock {
  /** Ref-based check (no stale closures) — true while a committed change awaits a fresh refresh. */
  isLocked: () => boolean;
  /** Reactive flag for disabling controls + showing the "saved, refresh required" banner. */
  refreshFailed: boolean;
  /** Retry the detail refresh; unlocks ONLY on a complete CAS-advanced result. */
  retryRefresh: () => Promise<void>;
  /**
   * Call after a committed mutation whose output cannot advance the local CAS. Revalidates the
   * detail; unlocks ONLY when the refresh returns a complete authoritative detail whose CAS has
   * demonstrably advanced from the locked pre-refresh snapshot — otherwise (undefined / incomplete
   * / same CAS / thrown) it stays LOCKED so a stale-CAS second write can never fire.
   */
  syncAfterCommit: () => Promise<void>;
}

export interface RefreshLockOptions<T> {
  /** The current (pre-refresh) detail. Read through a ref by the caller so it is never stale. */
  getSnapshot: () => T | undefined;
  /** True only when `result` is a complete authoritative detail advanced past `previous`. */
  isFresh: (result: T | undefined, previous: T | undefined) => boolean;
}

/**
 * Shared refresh gate for one Agent detail surface. A committed mutation followed by a refresh
 * that does not return a complete, CAS-advanced detail must not read as success, must not clear
 * recovery, and must block ALL further dangerous/agent/assignment writes on the stale snapshot
 * until an explicit refresh genuinely advances the CAS.
 */
export const useRefreshLock = <T>(
  mutate: () => Promise<T | undefined>,
  options: RefreshLockOptions<T>,
): RefreshLock => {
  const [refreshFailed, setRefreshFailed] = useState(false);
  const lockedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const sync = useCallback(async () => {
    const previous = optionsRef.current.getSnapshot();
    let fresh: T | undefined;
    try {
      fresh = await mutate();
    } catch {
      lockedRef.current = true;
      setRefreshFailed(true);
      return;
    }
    if (optionsRef.current.isFresh(fresh, previous)) {
      lockedRef.current = false;
      setRefreshFailed(false);
    } else {
      // Incomplete / undefined / unchanged CAS → keep locked and surface refresh-required.
      lockedRef.current = true;
      setRefreshFailed(true);
    }
  }, [mutate]);

  const isLocked = useCallback(() => lockedRef.current, []);

  return { isLocked, refreshFailed, retryRefresh: sync, syncAfterCommit: sync };
};
