/**
 * Fail-closed commit phase machine, owned-backend terminate, and lifecycle restore registration.
 */
import { Pool } from 'pg';

import { cleanupEnterpriseAdminSuite } from './cleanup';
import type { CommitPhase, SuiteGlobalWriteManifest, SuiteSeed } from './types';

export type DurableRestoreHandle = {
  databaseUrl: string;
  /**
   * Explicit commit state machine. Prefer this over boolean-only inference.
   * committed=true only when phase is 'committed' (kept for callers).
   */
  commitPhase: CommitPhase;
  /** True only when phase === 'committed'. Never true for ambiguous. */
  committed: boolean;
  /** Pre-built restore journal published before/at commit arm. Kept on ambiguous. */
  manifest: SuiteGlobalWriteManifest | null;
  seed: SuiteSeed | null;
  /** True when seed attempt finished (success or failure). */
  settled: boolean;
  whenSettled: Promise<void>;
  markSettled: () => void;
  /** Fail-closed: set when seed must not hang restore forever. */
  abortRestoreWait: () => void;
  /** Last reconcile error when ambiguous outcome cannot be proven. */
  reconcileError?: string;
  /** Read-only: number of active settle timers owned by restore hooks. */
  activeSettleTimers: number;
  /** PostgreSQL backend pid for the owned seed connection (for fail-closed terminate). */
  ownedBackendPid: null | number;
  /**
   * In-flight COMMIT promise. Never cleared while still pending — only after settle.
   * Kept even when phase becomes `ambiguous` so reconcile can refuse correctly.
   */
  commitInFlight: null | Promise<unknown>;
  /**
   * True while the real COMMIT promise has not settled.
   * Independent of phase label (`commitIssued`, `ambiguous`, …).
   */
  commitInFlightPending: boolean;
};

/** Module-level settle timer bookkeeping for tests (owned restore timers only). */
let globalActiveSettleTimers = 0;
export const getActiveSettleTimerCount = (): number => globalActiveSettleTimers;

/** Create an empty durable restore handle — register on lifecycle BEFORE calling seed. */
export const createDurableRestoreHandle = (databaseUrl: string): DurableRestoreHandle => {
  let settled = false;
  let resolveSettled: () => void = () => undefined;
  const whenSettled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const handle: DurableRestoreHandle = {
    abortRestoreWait: () => {
      handle.markSettled();
    },
    activeSettleTimers: 0,
    commitInFlight: null,
    commitInFlightPending: false,
    commitPhase: 'notStarted',
    committed: false,
    databaseUrl,
    manifest: null,
    ownedBackendPid: null,
    markSettled: () => {
      if (settled) return;
      settled = true;
      handle.settled = true;
      resolveSettled();
    },
    seed: null,
    settled: false,
    whenSettled,
  };
  return handle;
};

/** Clear commitInFlight reference only after the real promise has settled. */
export const clearCommitInFlightIfSettled = (durable: DurableRestoreHandle): void => {
  if (!durable.commitInFlightPending) {
    durable.commitInFlight = null;
  }
};

/** Arm tracking for a real COMMIT promise — pending until the promise settles. */
export const armCommitInFlight = (
  durable: DurableRestoreHandle,
  commitPromise: Promise<unknown>,
): void => {
  durable.commitInFlight = commitPromise;
  durable.commitInFlightPending = true;
  void commitPromise.then(
    () => {
      durable.commitInFlightPending = false;
    },
    () => {
      durable.commitInFlightPending = false;
    },
  );
};

/**
 * Wait for optional filesystem barrier (test seam for hang after commitStarted / post-COMMIT).
 * Release file aborts wait; deadline prevents infinite hang in production misuse.
 */
export const waitBarrierDir = async (
  dir: string,
  markerName: string,
  maxMs: number,
): Promise<void> => {
  const { writeFileSync, existsSync } = await import('node:fs');
  writeFileSync(`${dir}/${markerName}`, '1', 'utf8');
  const release = `${dir}/release`;
  const deadline = Date.now() + maxMs;
  while (!existsSync(release) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * After COMMIT was issued but result is unknown: query DB against journal.
 * Sets phase to committed (restorable) or rolledBack; if unprovable, keeps ambiguous and throws.
 */
export const reconcileAmbiguousCommit = async (durable: DurableRestoreHandle): Promise<void> => {
  // Refuse whenever any real COMMIT promise is still pending — independent of phase label.
  // Phase transitions (commitIssued → ambiguous) must not weaken this guard.
  if (durable.commitInFlightPending) {
    throw new Error(
      'fail-closed: cannot reconcile while COMMIT is still in-flight on owned backend',
    );
  }
  if (durable.commitPhase !== 'ambiguous' && durable.commitPhase !== 'commitIssued') {
    return;
  }
  if (!durable.manifest || !durable.seed) {
    durable.commitPhase = 'rolledBack';
    durable.committed = false;
    return;
  }
  const pool = new Pool({ connectionString: durable.databaseUrl });
  try {
    // Prove commit landed by checking a suite-created principal exists (after-state).
    const users = await pool.query(`SELECT id FROM users WHERE id = $1 LIMIT 1`, [
      durable.seed.ordinary.id,
    ]);
    if (users.rows[0]) {
      durable.commitPhase = 'committed';
      durable.committed = true;
      return;
    }
    // No suite principal after query finished → known rolled back / no pollution.
    // Only clear journal once COMMIT is no longer in-flight.
    durable.commitPhase = 'rolledBack';
    durable.committed = false;
    durable.manifest = null;
    durable.seed = null;
  } catch (error) {
    durable.commitPhase = 'ambiguous';
    durable.reconcileError = error instanceof Error ? error.message : String(error);
    throw new Error(
      `fail-closed: ambiguous COMMIT outcome cannot be reconciled (${durable.reconcileError}); journal preserved`,
      { cause: error },
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
};

/** Default wall-clock bounds for owned-backend terminate (connect + query + pool end). */
export const DEFAULT_TERMINATE_CONNECT_TIMEOUT_MS = 400;
export const DEFAULT_TERMINATE_QUERY_TIMEOUT_MS = 800;
export const DEFAULT_TERMINATE_OUTER_BOUND_MS = 1_500;

export type TerminateOwnedBackendOptions = {
  connectionTimeoutMs?: number;
  databaseUrl?: string;
  /** Override database URL used only for the terminate connection (tests: unresponsive TCP). */
  outerBoundMs?: number;
  queryTimeoutMs?: number;
};

/**
 * Terminate only the owned seed PostgreSQL backend (never foreign backends).
 * Entire attempt (connect + query + pool shutdown) is bounded — calculable max wall time.
 * Failures are NOT swallowed — preserve sanitized cause and backend identity.
 */
export const terminateOwnedSeedBackend = async (
  durable: DurableRestoreHandle,
  options?: TerminateOwnedBackendOptions,
): Promise<void> => {
  const pid = durable.ownedBackendPid;
  if (!pid) {
    throw new Error('fail-closed: no ownedBackendPid to terminate');
  }
  if (process.env.E2E_CAS_FORCE_TERMINATE_FAIL === '1') {
    const err = new Error(
      `forced owned-backend terminate connection/permission failure (backend=${pid})`,
    );
    durable.reconcileError = err.message;
    throw err;
  }
  const url = options?.databaseUrl ?? durable.databaseUrl;
  const rawConnect =
    options?.connectionTimeoutMs ?? Number(process.env.E2E_CAS_TERMINATE_CONNECT_MS);
  const rawQuery = options?.queryTimeoutMs ?? Number(process.env.E2E_CAS_TERMINATE_QUERY_MS);
  const rawOuter = options?.outerBoundMs ?? Number(process.env.E2E_CAS_TERMINATE_OUTER_MS);
  const connectionTimeoutMs =
    typeof rawConnect === 'number' && Number.isFinite(rawConnect) && rawConnect > 0
      ? rawConnect
      : DEFAULT_TERMINATE_CONNECT_TIMEOUT_MS;
  const queryTimeoutMs =
    typeof rawQuery === 'number' && Number.isFinite(rawQuery) && rawQuery > 0
      ? rawQuery
      : DEFAULT_TERMINATE_QUERY_TIMEOUT_MS;
  const outerBoundMs =
    typeof rawOuter === 'number' && Number.isFinite(rawOuter) && rawOuter > 0
      ? rawOuter
      : DEFAULT_TERMINATE_OUTER_BOUND_MS;

  const runTerminate = async (): Promise<void> => {
    const pool = new Pool({
      connectionString: url,
      connectionTimeoutMillis: connectionTimeoutMs,
      // One-shot admin connection
      max: 1,
    });
    try {
      await awaitWithBound(
        (async () => {
          // Bound server-side execution as well as client race.
          await pool.query(`SELECT set_config('statement_timeout', $1, false)`, [
            String(queryTimeoutMs),
          ]);
          const res = await pool.query<{ pg_terminate_backend: boolean }>(
            `SELECT pg_terminate_backend($1::int) AS pg_terminate_backend`,
            [pid],
          );
          // false means backend not found (already gone) — acceptable
          void res.rows[0];
        })(),
        queryTimeoutMs + connectionTimeoutMs + 200,
        'terminate owned backend query',
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Sanitize: do not embed connection strings
      const sanitized = msg.replaceAll(url, '[DATABASE_URL]').slice(0, 400);
      durable.reconcileError = `terminate owned backend ${pid} failed: ${sanitized}`;
      throw new Error(durable.reconcileError, { cause: error });
    } finally {
      try {
        await awaitWithBound(
          pool.end().catch(() => undefined),
          500,
          'terminate pool end',
        );
      } catch {
        // Pool end bound exceeded — drop reference; process must not hang.
        try {
          pool.end().catch(() => undefined);
        } catch {
          // ignore
        }
      }
    }
  };

  try {
    await awaitWithBound(runTerminate(), outerBoundMs, 'terminate owned backend');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const sanitized = msg.replaceAll(url, '[DATABASE_URL]').slice(0, 400);
    if (!durable.reconcileError) {
      durable.reconcileError = `terminate owned backend ${pid} failed: ${sanitized}`;
    }
    throw new Error(
      durable.reconcileError.startsWith('terminate owned backend')
        ? durable.reconcileError
        : `terminate owned backend ${pid} failed: ${sanitized}`,
      { cause: error },
    );
  }
};

export const awaitWithBound = async <T>(
  promise: Promise<T>,
  boundMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} exceeded bound ${boundMs}ms`));
        }, boundMs);
        if (typeof timer === 'object' && 'unref' in timer) {
          (timer as { unref: () => void }).unref();
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Single auditable resolution for commitIssued / in-flight COMMIT on cleanup/signal.
 * - Wait first settle bound for natural completion.
 * - If still pending: attempt owned-backend terminate (itself bounded; failures not swallowed).
 * - Await commitInFlight with a second explicit bound (never unbounded).
 * - Never drop the reference to a still-pending commitInFlight promise.
 * - Reconcile only after query is finished; preserve journal on failure.
 */
export const resolveIssuedCommitOnCleanup = async (
  durable: DurableRestoreHandle,
  options: {
    postTerminateBoundMs?: number;
    settleTimeoutMs: number;
    waitBounded: () => Promise<'settled' | 'timeout'>;
  },
): Promise<void> => {
  const postBound = options.postTerminateBoundMs ?? Math.max(2_000, options.settleTimeoutMs);
  const outcome = await options.waitBounded();
  const inflight: Promise<unknown> | null = durable.commitInFlight;

  if (!inflight && !durable.commitInFlightPending) {
    // Query already finished — reconcile if needed
    if (
      !durable.committed &&
      durable.commitPhase !== 'committed' &&
      durable.commitPhase !== 'rolledBack'
    ) {
      await reconcileAmbiguousCommit(durable);
    }
    return;
  }

  if (outcome === 'timeout') {
    try {
      // terminateOwnedSeedBackend has its own outer bound (connect+query+pool).
      await terminateOwnedSeedBackend(durable);
    } catch (termError) {
      // Fail closed: keep journal + backend identity + pending COMMIT reference.
      durable.commitPhase = 'ambiguous';
      durable.committed = false;
      // Do NOT clear commitInFlight / pending while promise may still be live.
      throw new Error(
        `fail-closed: owned-backend terminate failed after settle timeout; journal preserved (backend=${durable.ownedBackendPid ?? 'unknown'})`,
        { cause: termError },
      );
    }
  }

  if (inflight) {
    try {
      await awaitWithBound(
        Promise.resolve(inflight).then(
          () => undefined,
          () => undefined,
        ),
        postBound,
        'commitInFlight post-termination wait',
      );
    } catch (boundError) {
      durable.commitPhase = 'ambiguous';
      durable.committed = false;
      // NEVER clear a still-pending commitInFlight reference — reconcile must keep refusing.
      throw new Error(
        `fail-closed: commitInFlight still pending after bounded post-termination wait; journal preserved (backend=${durable.ownedBackendPid ?? 'unknown'})`,
        { cause: boundError },
      );
    }
  }

  // Clear reference only after the real promise has settled.
  clearCommitInFlightIfSettled(durable);

  if (durable.commitInFlightPending) {
    durable.commitPhase = 'ambiguous';
    durable.committed = false;
    throw new Error(
      `fail-closed: commitInFlight still pending after bounded post-termination wait; journal preserved (backend=${durable.ownedBackendPid ?? 'unknown'})`,
    );
  }

  if (!durable.committed) {
    await reconcileAmbiguousCommit(durable);
  }
};

export const isRestorablePhase = (phase: CommitPhase): boolean =>
  phase === 'committed' || phase === 'ambiguous' || phase === 'commitIssued';

export const registerSeedRestoreOnLifecycle = (
  state: {
    preCleanupHooks: Array<() => Promise<void>>;
  },
  durableRestore: DurableRestoreHandle,
  options?: { settleTimeoutMs?: number },
): void => {
  let restored = false;
  const settleTimeoutMs = options?.settleTimeoutMs ?? 8_000;
  // Helpers re-read handle fields so TS does not freeze commitPhase after control-flow narrowing.
  const phaseOf = (d: DurableRestoreHandle): CommitPhase => d.commitPhase;
  const isFullyCommitted = (d: DurableRestoreHandle): boolean =>
    d.committed || phaseOf(d) === 'committed';

  const waitBounded = async (ms: number): Promise<'settled' | 'timeout'> => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const racers: Array<Promise<'settled' | 'timeout'>> = [
      durableRestore.whenSettled.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve('timeout');
        }, ms);
        globalActiveSettleTimers += 1;
        durableRestore.activeSettleTimers += 1;
        if (typeof timer === 'object' && 'unref' in timer) {
          (timer as { unref: () => void }).unref();
        }
      }),
    ];
    if (durableRestore.commitInFlight) {
      racers.push(
        durableRestore.commitInFlight
          .then(() => 'settled' as const)
          .catch(() => 'settled' as const),
      );
    }
    try {
      await Promise.race(racers);
    } finally {
      if (timer) {
        clearTimeout(timer);
        globalActiveSettleTimers = Math.max(0, globalActiveSettleTimers - 1);
        durableRestore.activeSettleTimers = Math.max(0, durableRestore.activeSettleTimers - 1);
      }
    }
    return timedOut ? 'timeout' : 'settled';
  };

  state.preCleanupHooks.push(async () => {
    const restoreOnce = async () => {
      if (restored) return;
      if (!durableRestore.seed || !durableRestore.manifest) return;
      if (!isRestorablePhase(phaseOf(durableRestore)) && !durableRestore.committed) {
        return;
      }
      restored = true;
      await cleanupEnterpriseAdminSuite(
        durableRestore.databaseUrl,
        durableRestore.seed,
        durableRestore.manifest,
      );
    };

    // Prefer immediate restore when already restorable (even if seed hangs post-commit).
    if (isFullyCommitted(durableRestore) && durableRestore.manifest && durableRestore.seed) {
      await restoreOnce();
      return;
    }

    // COMMIT issued / in-flight: single auditable resolution (never unbounded await).
    if (
      phaseOf(durableRestore) === 'commitIssued' ||
      durableRestore.commitInFlightPending ||
      durableRestore.commitInFlight
    ) {
      await resolveIssuedCommitOnCleanup(durableRestore, {
        postTerminateBoundMs: Math.max(2_000, settleTimeoutMs),
        settleTimeoutMs,
        waitBounded: () => waitBounded(settleTimeoutMs),
      });
      if (isFullyCommitted(durableRestore)) {
        await restoreOnce();
        return;
      }
      if (phaseOf(durableRestore) === 'rolledBack') {
        return;
      }
      if (phaseOf(durableRestore) === 'ambiguous' && durableRestore.manifest) {
        try {
          await restoreOnce();
        } catch {
          throw new Error(
            'fail-closed: ambiguous COMMIT after owned-backend resolution; journal preserved',
          );
        }
      }
      return;
    }

    // Outcome known ambiguous (e.g. deferred raise / client withhold after query finished).
    // Still refuse if a COMMIT promise is pending (phase label must not weaken the guard).
    if (phaseOf(durableRestore) === 'ambiguous') {
      await reconcileAmbiguousCommit(durableRestore);
      if (isFullyCommitted(durableRestore)) {
        await restoreOnce();
        return;
      }
      if (phaseOf(durableRestore) === 'rolledBack') {
        return;
      }
      throw new Error(
        'fail-closed: ambiguous COMMIT with unrecovered journal — refuse silent return',
      );
    }

    // notStarted: wait for settle with bounded fail-closed timeout.
    const outcome = await waitBounded(settleTimeoutMs);

    // Seed may have advanced to commitIssued while we waited.
    if (
      phaseOf(durableRestore) === 'commitIssued' ||
      durableRestore.commitInFlightPending ||
      durableRestore.commitInFlight
    ) {
      await resolveIssuedCommitOnCleanup(durableRestore, {
        postTerminateBoundMs: Math.max(2_000, settleTimeoutMs),
        settleTimeoutMs,
        // already waited once — use a short bound for any remaining wait
        waitBounded: async () => {
          if (!durableRestore.commitInFlightPending && !durableRestore.commitInFlight) {
            return 'settled';
          }
          return waitBounded(Math.min(500, settleTimeoutMs));
        },
      });
    } else if (phaseOf(durableRestore) === 'ambiguous') {
      await reconcileAmbiguousCommit(durableRestore);
    }

    if (isFullyCommitted(durableRestore) && durableRestore.manifest && durableRestore.seed) {
      await restoreOnce();
      return;
    }

    if (outcome === 'timeout' && phaseOf(durableRestore) === 'notStarted') {
      return;
    }
    if (isFullyCommitted(durableRestore)) {
      await restoreOnce();
      return;
    }
    if (outcome === 'timeout' && durableRestore.manifest && durableRestore.seed) {
      throw new Error(
        `fail-closed: seed settle timeout with phase=${phaseOf(durableRestore)}; journal preserved`,
      );
    }
  });
};
