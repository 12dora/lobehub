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

const log = debug('lobe-server:enterprise-operational-metrics');

interface OperationalMetricsTimer {
  clear?: () => void;
  unref?: () => void;
}

interface OperationalMetricsProcessState {
  collectionInFlight: boolean;
  startPromise: Promise<boolean> | null;
  timer: OperationalMetricsTimer | null;
}

const operationalMetricsProcess = process as NodeJS.Process & {
  __lobehubEnterpriseOperationalMetricsState?: OperationalMetricsProcessState;
};

const createProcessState = (): OperationalMetricsProcessState => ({
  collectionInFlight: false,
  startPromise: null,
  timer: null,
});

const processState = (): OperationalMetricsProcessState =>
  (operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState ??= createProcessState());

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
  schedule?: (callback: () => void, delay: number) => OperationalMetricsTimer;
}

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

export const ensureOperationalMetricsRuntimeStarted = async (
  options: OperationalMetricsRuntimeOptions = {},
): Promise<boolean> => {
  const env = options.env ?? process.env;
  if (!shouldStartOperationalMetricsRuntime(env)) return false;

  const state = processState();
  if (state.timer) return true;
  if (state.startPromise) return state.startPromise;

  const start = async (): Promise<boolean> => {
    const collectors: EnterpriseOperationalCollector[] = ['job_backlog'];
    if (parseEnterpriseFeatureFlags(env).ENABLE_DATABASE_OIDC) collectors.push('revision_lag');
    const metricSink = options.metricSink ?? defaultMetricSink;
    const now = options.now ?? Date.now;
    const reportFailure = options.logFailure ?? defaultLogFailure;
    metricSink.activate(collectors);

    let db: LobeChatDatabase;
    try {
      db = await (options.getDatabase ?? defaultGetDatabase)();
    } catch (error) {
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
      return false;
    }

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
        observeEnterprisePlatformEvent({
          collector,
          durationMs: now() - startedAt,
          outcome: 'success',
          type: 'operational_collection',
        });
      } catch (error) {
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
      if (state.collectionInFlight) return;
      state.collectionInFlight = true;
      try {
        const tasks = [
          collectOne('job_backlog', async () => {
            const snapshot = await jobs.getBacklogSnapshot();
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
              const snapshot = await instances.getIdentityRevisionLagSnapshot(
                target.identityRevision,
              );
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

export const resetOperationalMetricsRuntimeForTest = (): void => {
  operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState?.timer?.clear?.();
  delete operationalMetricsProcess.__lobehubEnterpriseOperationalMetricsState;
  resetEnterpriseOperationalMetricsForTest();
};
