'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * A write token identifies ONE logical mutation. It is created once when the user confirms an
 * action and captured by that action's callbacks, so a shared-reauth challenge + its single retry
 * re-enter with the SAME token (the same logical write) while any DIFFERENT concurrent mutation
 * carries a different token and is rejected.
 */
export type WriteToken = object;

export interface RefreshLock {
  /** A pending write's service failed WITHOUT committing → release the cycle (safe re-entrant). */
  abortWrite: (token: WriteToken) => void;
  /**
   * Synchronously begin a write BEFORE its service call. On the first entry of a cycle it freezes
   * the complete pre-write baseline and locks immediately (closing the service-pending window);
   * returns `true`. A re-entry with the SAME (still-pending, uncommitted) token — the shared-reauth
   * retry — also returns `true` without re-freezing. Any other call while a cycle is active returns
   * `false`, so a concurrent/second mutation is rejected locally and never reaches the service.
   */
  beginWrite: (token: WriteToken) => boolean;
  /**
   * A committed write whose output carries NO advanced CAS (e.g. publish/rollback/assignment).
   * Keeps the frozen baseline and refreshes; unlocks ONLY when the refresh returns a complete
   * authoritative detail advanced past the baseline, otherwise stays LOCKED (refreshFailed).
   */
  commitWrite: (token: WriteToken) => Promise<void>;
  /** Ref-based (no stale closures): true while ANY write cycle is active (pending or awaiting refresh). */
  isLocked: () => boolean;
  /** Reactive mirror of `isLocked` for disabling controls the moment a write starts. */
  locked: boolean;
  /** Reactive: a committed change whose refresh has not yet advanced the CAS (banner + disable). */
  refreshFailed: boolean;
  /**
   * A committed write whose output ALREADY carries the authoritative advanced CAS (applied to local
   * state by the caller). Ends the cycle and unlocks — no refresh needed.
   */
  resolveWrite: (token: WriteToken) => void;
  /** Manually retry the post-commit refresh; unlocks ONLY on a fresh CAS-advanced detail. */
  retryRefresh: () => Promise<void>;
}

export interface RefreshLockOptions<T> {
  /** The current (pre-refresh) detail. Read through a ref by the caller so it is never stale. */
  getSnapshot: () => T | undefined;
  /** True only when `result` is a complete authoritative detail advanced past the frozen `baseline`. */
  isFresh: (result: T | undefined, baseline: T | undefined) => boolean;
}

/**
 * Shared write gate for one Agent detail surface with an explicit pre-write lifecycle:
 * `beginWrite` (freeze baseline + lock) → service → `resolveWrite` (CAS advanced locally) /
 * `commitWrite` (refresh-and-verify) / `abortWrite` (service failed, no commit). The baseline is
 * frozen at the first begin of a cycle and NEVER replaced by a background revalidation until the
 * cycle ends, so a stale-CAS second write can never fire on a committed-but-unrefreshed snapshot.
 */
export const useRefreshLock = <T>(
  mutate: () => Promise<T | undefined>,
  options: RefreshLockOptions<T>,
): RefreshLock => {
  const [locked, setLocked] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const lockedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // The active cycle: its write token, whether it has committed, and the frozen pre-write baseline.
  const tokenRef = useRef<WriteToken | null>(null);
  const committedRef = useRef(false);
  const baselineRef = useRef<{ value: T | undefined } | null>(null);

  const isLocked = useCallback(() => lockedRef.current, []);

  const endCycle = useCallback(() => {
    lockedRef.current = false;
    tokenRef.current = null;
    committedRef.current = false;
    baselineRef.current = null;
    setLocked(false);
    setRefreshFailed(false);
  }, []);

  const beginWrite = useCallback((token: WriteToken): boolean => {
    if (!lockedRef.current) {
      // First entry of a new cycle: freeze the complete pre-write baseline and lock immediately.
      lockedRef.current = true;
      tokenRef.current = token;
      committedRef.current = false;
      baselineRef.current = { value: optionsRef.current.getSnapshot() };
      setLocked(true);
      setRefreshFailed(false);
      return true;
    }
    // A cycle is active: allow ONLY the same still-pending write (the reauth retry). Reject a
    // different token, and reject re-entry once the write has committed (awaiting refresh).
    return tokenRef.current === token && !committedRef.current;
  }, []);

  const abortWrite = useCallback(
    (token: WriteToken) => {
      // Only the owning, not-yet-committed write may abort — never tear down a committed cycle.
      if (tokenRef.current === token && !committedRef.current) endCycle();
    },
    [endCycle],
  );

  const resolveWrite = useCallback(
    (token: WriteToken) => {
      if (tokenRef.current !== token) return;
      committedRef.current = true; // authoritative CAS already advanced locally → just unlock
      endCycle();
    },
    [endCycle],
  );

  const refresh = useCallback(async () => {
    // Only a committed cycle has a frozen baseline to refresh against; otherwise there is nothing to
    // unlock and a stray retry must never flip the surface into a locked state.
    if (baselineRef.current === null) return;
    const baseline = baselineRef.current.value;
    let fresh: T | undefined;
    try {
      fresh = await mutate();
    } catch {
      lockedRef.current = true;
      setLocked(true);
      setRefreshFailed(true);
      return;
    }
    if (optionsRef.current.isFresh(fresh, baseline)) {
      endCycle();
    } else {
      // Undefined / incomplete / not-advanced → keep locked with the SAME frozen baseline.
      lockedRef.current = true;
      setLocked(true);
      setRefreshFailed(true);
    }
  }, [endCycle, mutate]);

  const commitWrite = useCallback(
    async (token: WriteToken) => {
      if (tokenRef.current !== token) return;
      committedRef.current = true; // mark committed BEFORE awaiting so a late abort cannot unlock it
      await refresh();
    },
    [refresh],
  );

  return {
    abortWrite,
    beginWrite,
    commitWrite,
    isLocked,
    locked,
    refreshFailed,
    resolveWrite,
    retryRefresh: refresh,
  };
};
