import type {
  EnterpriseJobBacklogMetricSnapshot,
  EnterpriseOperationalCollector,
  EnterpriseRevisionLagMetricSnapshot,
} from '@lobechat/observability-otel/modules/enterprise-platform';
import {
  activateEnterpriseOperationalCollectors,
  resetEnterpriseOperationalMetricsForTest,
  setEnterpriseJobBacklogMetricSnapshot,
  setEnterpriseRevisionLagMetricSnapshot,
} from '@lobechat/observability-otel/modules/enterprise-platform';
import debug from 'debug';

import {
  ENTERPRISE_FEATURE_FLAG_KEYS,
  isEnterpriseFlagTruthy,
} from '@/const/platform/featureFlags';
import { PlatformJobModel } from '@/database/models/platform/job';
import { PlatformInstanceRepository } from '@/database/repositories/platformInstance';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { classifyEnterpriseError, observeEnterprisePlatformEvent } from '../../observability';
import { loadPublishedIdentityTarget } from '../identityProvider/systemService';

export const OPERATIONAL_METRICS_COLLECTION_INTERVAL_MS = 60_000;
/** Initial backoff after a failed database acquisition / first collect (SAO-007). */
export const OPERATIONAL_METRICS_STARTUP_RETRY_BASE_MS = 5_000;
/** Cap for exponential startup retry so recovery stays bounded. */
export const OPERATIONAL_METRICS_STARTUP_RETRY_MAX_MS = 60_000;

const log = debug('lobe-server:enterprise-operational-metrics');

interface OperationalMetricsTimer {
  clear?: () => void;
  unref?: () => void;
}

interface OperationalMetricsProcessState {
  collectionInFlight: boolean;
  generation: number;
  metricSink: OperationalMetricSink | null;
  retired: boolean;
  /** One-shot startup retry timer (distinct from the recurring collection timer). */
  retryTimer: OperationalMetricsTimer | null;
  startPromise: Promise<boolean> | null;
  /** Consecutive failed startup attempts (resets on successful timer install). */
  startupFailures: number;
  timer: OperationalMetricsTimer | null;
}

const operationalMetricsProcess = process as NodeJS.Process & {
  __lobehubEnterpriseOperationalMetricsGeneration?: number;
  __lobehubEnterpriseOperationalMetricsState?: OperationalMetricsProcessState;
};

const createProcessState = (): OperationalMetricsProcessState => ({
  collectionInFlight: false,
  generation: (operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsGeneration ?? 0) + 1,
  metricSink: null,
  retired: false,
  retryTimer: null,
  startPromise: null,
  startupFailures: 0,
  timer: null,
});

const processState = (): OperationalMetricsProcessState => {
  if (operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState) {
    return operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState;
  }

  const state = createProcessState();
  operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsGeneration = state.generation;
  operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState = state;
  return state;
};

const isCurrentGeneration = (state: OperationalMetricsProcessState): boolean => {
  const current = operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState;
  return !state.retired && current === state && current.generation === state.generation;
};

interface OperationalMetricSink {
  activate: (collectors: readonly EnterpriseOperationalCollector[]) => void;
  setJobBacklog: (snapshot: EnterpriseJobBacklogMetricSnapshot) => void;
  setRevisionLag: (snapshot: EnterpriseRevisionLagMetricSnapshot) => void;
}

const defaultMetricSink: OperationalMetricSink = {
  activate: activateEnterpriseOperationalCollectors,
  setJobBacklog: setEnterpriseJobBacklogMetricSnapshot,
  setRevisionLag: setEnterpriseRevisionLagMetricSnapshot,
};

export interface OperationalMetricsRuntimeOptions {
  createInstanceRepository?: (
    db: LobeChatDatabase,
  ) => Pick<PlatformInstanceRepository, 'getIdentityRevisionLagSnapshot'>;
  createJobModel?: (db: LobeChatDatabase) => Pick<PlatformJobModel, 'getBacklogSnapshot'>;
  env?: Record<string, string | undefined>;
  getDatabase?: () => Promise<LobeChatDatabase>;
  loadIdentityTarget?: typeof loadPublishedIdentityTarget;
  logFailure?: (event: {
    collector: EnterpriseOperationalCollector;
    errorClass: ReturnType<typeof classifyEnterpriseError>;
  }) => void;
  metricSink?: OperationalMetricSink;
  now?: () => number;
  /** Recurring collection timer (setInterval semantics). */
  schedule?: (callback: () => void, delay: number) => OperationalMetricsTimer;
  /**
   * One-shot startup retry timer (setTimeout semantics). Defaults to setTimeout.
   * Distinct from {@link schedule} so tests can assert retry vs interval separately.
   */
  scheduleRetry?: (callback: () => void, delay: number) => OperationalMetricsTimer;
}

/** Exponential backoff with ±20% jitter; capped at OPERATIONAL_METRICS_STARTUP_RETRY_MAX_MS. */
export const computeOperationalMetricsStartupRetryDelayMs = (
  failures: number,
  random: () => number = Math.random,
): number => {
  const exp = Math.min(
    OPERATIONAL_METRICS_STARTUP_RETRY_MAX_MS,
    OPERATIONAL_METRICS_STARTUP_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
  );
  const jitter = exp * 0.2 * (random() * 2 - 1);
  return Math.max(OPERATIONAL_METRICS_STARTUP_RETRY_BASE_MS / 2, Math.round(exp + jitter));
};

const isBuildRuntime = (env: Record<string, string | undefined>): boolean =>
  env.NEXT_PHASE === 'phase-production-build' || env.npm_lifecycle_event === 'build';

const isEphemeralRuntime = (env: Record<string, string | undefined>): boolean =>
  Boolean(
    env.VERCEL ||
    env.VERCEL_ENV ||
    env.AWS_LAMBDA_FUNCTION_NAME ||
    env.AWS_EXECUTION_ENV?.startsWith('AWS_Lambda_'),
  );

export const shouldStartOperationalMetricsRuntime = (
  env: Record<string, string | undefined>,
): boolean =>
  env.NODE_ENV === 'production' &&
  env.NEXT_RUNTIME === 'nodejs' &&
  Boolean(env.DATABASE_URL) &&
  isEnterpriseFlagTruthy(env.ENABLE_TELEMETRY) &&
  !isBuildRuntime(env) &&
  !isEphemeralRuntime(env) &&
  ENTERPRISE_FEATURE_FLAG_KEYS.some((key) => isEnterpriseFlagTruthy(env[key]));

const defaultGetDatabase = async (): Promise<LobeChatDatabase> => {
  const { getServerDB } = await import('@/database/core/db-adaptor');
  return getServerDB();
};

const defaultLogFailure: NonNullable<OperationalMetricsRuntimeOptions['logFailure']> = ({
  collector,
  errorClass,
}) => {
  log('collector unavailable collector=%s errorClass=%s', collector, errorClass);
};

const defaultSchedule = (callback: () => void, delay: number): OperationalMetricsTimer => {
  const timer = setInterval(callback, delay);
  return { clear: () => clearInterval(timer), unref: () => timer.unref() };
};

const defaultScheduleRetry = (callback: () => void, delay: number): OperationalMetricsTimer => {
  const timer = setTimeout(callback, delay);
  return { clear: () => clearTimeout(timer), unref: () => timer.unref() };
};

export const ensureOperationalMetricsRuntimeStarted = async (
  options: OperationalMetricsRuntimeOptions = {},
): Promise<boolean> => {
  const env = options.env ?? process.env;
  if (!shouldStartOperationalMetricsRuntime(env)) return false;

  const state = processState();
  if (state.timer) return true;
  if (state.startPromise) return state.startPromise;

  const scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry;

  const armStartupRetry = (): void => {
    if (!isCurrentGeneration(state) || state.timer || state.retryTimer) return;
    state.startupFailures += 1;
    const delayMs = computeOperationalMetricsStartupRetryDelayMs(state.startupFailures);
    state.retryTimer = scheduleRetry(() => {
      state.retryTimer = null;
      if (!isCurrentGeneration(state) || state.timer) return;
      void ensureOperationalMetricsRuntimeStarted(options);
    }, delayMs);
    state.retryTimer.unref?.();
  };

  const start = async (): Promise<boolean> => {
    const collectors: EnterpriseOperationalCollector[] = ['job_backlog'];
    if (parseEnterpriseFeatureFlags(env).ENABLE_DATABASE_OIDC) collectors.push('revision_lag');
    const metricSink = options.metricSink ?? defaultMetricSink;
    const now = options.now ?? Date.now;
    const reportFailure = options.logFailure ?? defaultLogFailure;
    if (!isCurrentGeneration(state)) return false;
    state.metricSink = metricSink;
    metricSink.activate(collectors);

    let db: LobeChatDatabase;
    try {
      db = await (options.getDatabase ?? defaultGetDatabase)();
    } catch (error) {
      if (!isCurrentGeneration(state)) return false;
      const errorClass = classifyEnterpriseError(error);
      for (const collector of collectors) {
        observeEnterprisePlatformEvent({
          collector,
          durationMs: 0,
          errorClass,
          outcome: 'failure',
          type: 'operational_collection',
        });
        reportFailure({ collector, errorClass });
      }
      // Schedule bounded retry so a transient DB outage at boot does not permanently
      // disable operational gauges for the process lifetime (SAO-007).
      armStartupRetry();
      return false;
    }
    if (!isCurrentGeneration(state)) return false;

    const jobs = options.createJobModel ? options.createJobModel(db) : new PlatformJobModel(db);
    const instances = options.createInstanceRepository
      ? options.createInstanceRepository(db)
      : new PlatformInstanceRepository(db);
    const resolveIdentityTarget = options.loadIdentityTarget ?? loadPublishedIdentityTarget;

    const collectOne = async (
      collector: EnterpriseOperationalCollector,
      collect: () => Promise<void>,
    ): Promise<void> => {
      const startedAt = now();
      try {
        await collect();
        if (!isCurrentGeneration(state)) return;
        observeEnterprisePlatformEvent({
          collector,
          durationMs: now() - startedAt,
          outcome: 'success',
          type: 'operational_collection',
        });
      } catch (error) {
        if (!isCurrentGeneration(state)) return;
        const errorClass = classifyEnterpriseError(error);
        observeEnterprisePlatformEvent({
          collector,
          durationMs: now() - startedAt,
          errorClass,
          outcome: 'failure',
          type: 'operational_collection',
        });
        reportFailure({ collector, errorClass });
      }
    };

    const collect = async (): Promise<void> => {
      if (!isCurrentGeneration(state) || state.collectionInFlight) return;
      state.collectionInFlight = true;
      try {
        const tasks = [
          collectOne('job_backlog', async () => {
            const snapshot = await jobs.getBacklogSnapshot();
            if (!isCurrentGeneration(state)) return;
            metricSink.setJobBacklog({
              collectedAtMs: snapshot.snapshotAt.getTime(),
              entries: snapshot.entries,
            });
          }),
        ];
        if (collectors.includes('revision_lag')) {
          tasks.push(
            collectOne('revision_lag', async () => {
              const target = await resolveIdentityTarget(db, env);
              if (!isCurrentGeneration(state)) return;
              const snapshot = await instances.getIdentityRevisionLagSnapshot(
                target.identityRevision,
              );
              if (!isCurrentGeneration(state)) return;
              metricSink.setRevisionLag({
                collectedAtMs: snapshot.snapshotAt.getTime(),
                domain: 'identity',
                freshInstances: snapshot.freshInstances,
                laggingInstances: snapshot.laggingInstances,
              });
            }),
          );
        }
        await Promise.all(tasks);
      } finally {
        state.collectionInFlight = false;
      }
    };

    await collect();
    if (!isCurrentGeneration(state)) return false;
    // Clear any pending startup retry and install the recurring collector.
    state.retryTimer?.clear?.();
    state.retryTimer = null;
    state.startupFailures = 0;
    state.timer = (options.schedule ?? defaultSchedule)(
      () => void collect(),
      OPERATIONAL_METRICS_COLLECTION_INTERVAL_MS,
    );
    state.timer.unref?.();
    return true;
  };

  const startPromise = start();
  state.startPromise = startPromise;
  try {
    return await startPromise;
  } finally {
    if (state.startPromise === startPromise) state.startPromise = null;
  }
};

export const stopOperationalMetricsRuntime = (): void => {
  const state = operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState;
  if (!state) return;

  state.retired = true;
  state.timer?.clear?.();
  state.timer = null;
  state.retryTimer?.clear?.();
  state.retryTimer = null;
  state.metricSink?.activate([]);
  if (operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState === state) {
    delete operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState;
  }
};

export const resetOperationalMetricsRuntimeForTest = (): void => {
  stopOperationalMetricsRuntime();
  resetEnterpriseOperationalMetricsForTest();
};
