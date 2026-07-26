import debug from 'debug';

const DEFAULT_MAX_BACKOFF_MS = 60_000;
const JITTER_RATIO = 0.2;

export interface PersistentWorkerScheduler {
  stop: () => void;
}

export interface PersistentWorkerSchedulerOptions {
  baseIntervalMs: number;
  maxBackoffMs?: number;
  namespace: string;
  random?: () => number;
  run: () => Promise<void>;
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

/**
 * Start one non-overlapping timer loop. Success resets retry state; failures use
 * capped exponential backoff and jitter so replicas do not hammer dependencies
 * in lockstep during an outage.
 */
export const startPersistentWorkerScheduler = (
  options: PersistentWorkerSchedulerOptions,
): PersistentWorkerScheduler => {
  const log = debug(`lobe-server:enterprise-worker:${options.namespace}`);
  const random = options.random ?? Math.random;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  let consecutiveFailures = 0;
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
      await options.run();
      consecutiveFailures = 0;
    } catch (error) {
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
