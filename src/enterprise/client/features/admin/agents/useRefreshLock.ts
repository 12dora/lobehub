'use client';

import { useCallback, useRef, useState } from 'react';

export interface RefreshLock {
  /** Ref-based check (no stale closures) — true while a committed change awaits a fresh refresh. */
  isLocked: () => boolean;
  /** Reactive flag for disabling controls + showing the "saved, refresh required" banner. */
  refreshFailed: boolean;
  /** Retry the detail refresh; unlocks ONLY on a complete detail advanced past the FROZEN baseline. */
  retryRefresh: () => Promise<void>;
  /**
   * Call after a committed mutation whose output cannot advance the local CAS. On the FIRST call of
   * a lock cycle it freezes the pre-commit baseline; every subsequent call (manual or background
   * retry) compares the refresh result against that FROZEN baseline — never a possibly-advanced
   * current snapshot. Unlocks ONLY when the result is a complete authoritative detail whose CAS has
   * demonstrably advanced past the baseline; otherwise (undefined / incomplete / not-advanced /
   * thrown) it stays LOCKED so a stale-CAS second write can never fire.
   */
  syncAfterCommit: () => Promise<void>;
}

export interface RefreshLockOptions<T> {
  /** The current (pre-refresh) detail. Read through a ref by the caller so it is never stale. */
  getSnapshot: () => T | undefined;
  /** True only when `result` is a complete authoritative detail advanced past the frozen `baseline`. */
  isFresh: (result: T | undefined, baseline: T | undefined) => boolean;
}

/**
 * Shared refresh gate for one Agent detail surface. A committed mutation followed by a refresh
 * that does not return a complete, CAS-advanced detail must not read as success, must not clear
 * recovery, and must block ALL further dangerous/agent/assignment writes on the stale snapshot
 * until an explicit refresh genuinely advances the CAS past the frozen pre-commit baseline.
 */
export const useRefreshLock = <T>(
  mutate: () => Promise<T | undefined>,
  options: RefreshLockOptions<T>,
): RefreshLock => {
  const [refreshFailed, setRefreshFailed] = useState(false);
  const lockedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // The pre-commit baseline, frozen once per lock cycle. `null` = no cycle in progress.
  const baselineRef = useRef<{ value: T | undefined } | null>(null);

  const sync = useCallback(async () => {
    // Freeze the pre-commit baseline exactly once, at the first sync of this cycle. All later
    // retries reuse it, even if a background revalidation has since advanced the live snapshot.
    if (baselineRef.current === null) {
      baselineRef.current = { value: optionsRef.current.getSnapshot() };
    }
    const baseline = baselineRef.current.value;

    let fresh: T | undefined;
    try {
      fresh = await mutate();
    } catch {
      lockedRef.current = true;
      setRefreshFailed(true);
      return;
    }
    if (optionsRef.current.isFresh(fresh, baseline)) {
      lockedRef.current = false;
      setRefreshFailed(false);
      baselineRef.current = null; // cycle complete → next commit freezes a new baseline
    } else {
      // Incomplete / undefined / not-advanced → keep locked with the SAME frozen baseline.
      lockedRef.current = true;
      setRefreshFailed(true);
    }
  }, [mutate]);

  const isLocked = useCallback(() => lockedRef.current, []);

  return { isLocked, refreshFailed, retryRefresh: sync, syncAfterCommit: sync };
};
