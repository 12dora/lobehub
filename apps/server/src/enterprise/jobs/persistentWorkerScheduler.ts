import debug from 'debug';

const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_MAX_IDLE_INTERVAL_MS = 60_000;
const IDLE_BACKOFF_AFTER = 3;
const JITTER_RATIO = 0.2;

export interface PersistentWorkerScheduler {
  stop: () => void;
}

export interface PersistentWorkerRunResult {
  didWork: boolean;
}

export interface PersistentWorkerSchedulerOptions {
  baseIntervalMs: number;
  maxBackoffMs?: number;
  /** Cap for idle (no-work) backoff. Default 60s. */
  maxIdleIntervalMs?: number;
  namespace: string;
  random?: () => number;
  /**
   * Return `{ didWork: false }` after a dry poll to engage idle backoff.
   * `void` (or `{ didWork: true }`) resets to `baseIntervalMs`.
   */
  run: () => Promise<PersistentWorkerRunResult | void>;
}

/** Capped exponential retry delay with ±20% replica jitter. */
export const calculatePersistentWorkerRetryDelay = (
  baseIntervalMs: number,
  consecutiveFailures: number,
  maxBackoffMs: number = DEFAULT_MAX_BACKOFF_MS,
  random: () => number = Math.random,
): number => {
  const exponential = Math.min(
    maxBackoffMs,
    baseIntervalMs * 2 ** Math.max(1, consecutiveFailures),
  );
  const jitter = exponential * JITTER_RATIO * (random() * 2 - 1);
  return Math.min(maxBackoffMs, Math.max(baseIntervalMs, Math.round(exponential + jitter)));
};

/** After `IDLE_BACKOFF_AFTER` dry runs, double the delay each tick up to the cap. */
export const calculatePersistentWorkerIdleDelay = (
  baseIntervalMs: number,
  consecutiveIdle: number,
  maxIdleIntervalMs: number = DEFAULT_MAX_IDLE_INTERVAL_MS,
): number => {
  if (consecutiveIdle < IDLE_BACKOFF_AFTER) return baseIntervalMs;
  const multiplier = 2 ** (consecutiveIdle - (IDLE_BACKOFF_AFTER - 1));
  return Math.min(maxIdleIntervalMs, baseIntervalMs * multiplier);
};

/**
 * Start one non-overlapping timer loop. Success resets retry state; failures use
 * capped exponential backoff and jitter so replicas do not hammer dependencies
 * in lockstep during an outage. Consecutive `{ didWork: false }` ticks idle-backoff.
 */
export const startPersistentWorkerScheduler = (
  options: PersistentWorkerSchedulerOptions,
): PersistentWorkerScheduler => {
  const log = debug(`lobe-server:enterprise-worker:${options.namespace}`);
  const random = options.random ?? Math.random;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxIdleIntervalMs = options.maxIdleIntervalMs ?? DEFAULT_MAX_IDLE_INTERVAL_MS;
  let consecutiveFailures = 0;
  let consecutiveIdle = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(run, delayMs);
    timer.unref();
  };

  const run = async () => {
    let delayMs = options.baseIntervalMs;
    try {
      const result = await options.run();
      consecutiveFailures = 0;
      if (result && result.didWork === false) {
        consecutiveIdle += 1;
        delayMs = calculatePersistentWorkerIdleDelay(
          options.baseIntervalMs,
          consecutiveIdle,
          maxIdleIntervalMs,
        );
      } else {
        consecutiveIdle = 0;
      }
    } catch (error) {
      consecutiveIdle = 0;
      consecutiveFailures += 1;
      delayMs = calculatePersistentWorkerRetryDelay(
        options.baseIntervalMs,
        consecutiveFailures,
        maxBackoffMs,
        random,
      );
      log('batch failed %O', {
        consecutiveFailures,
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        retryDelayMs: delayMs,
      });
    } finally {
      schedule(delayMs);
    }
  };

  void run();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
};
