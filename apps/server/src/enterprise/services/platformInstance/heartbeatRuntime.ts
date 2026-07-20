import { randomBytes } from 'node:crypto';

import debug from 'debug';

import {
  ENTERPRISE_FEATURE_FLAG_KEYS,
  isEnterpriseFlagTruthy,
} from '@/const/platform/featureFlags';
import {
  PLATFORM_INSTANCE_HEARTBEAT_INTERVAL_MS,
  PlatformInstanceRepository,
} from '@/database/repositories/platformInstance';
import type { LobeChatDatabase } from '@/database/type';

import { classifyEnterpriseError, observeEnterprisePlatformEvent } from '../../observability';

const log = debug('lobe-server:platform-instance-heartbeat');

interface PlatformInstanceHeartbeatTimer {
  clear?: () => void;
  unref?: () => void;
}

interface PlatformInstanceHeartbeatProcessState {
  heartbeatInFlight: boolean;
  instanceId: string;
  startPromise: Promise<boolean> | null;
  timer: PlatformInstanceHeartbeatTimer | null;
}

const heartbeatProcess = process as NodeJS.Process & {
  __lobehubPlatformInstanceHeartbeatState?: PlatformInstanceHeartbeatProcessState;
};

const createProcessState = (): PlatformInstanceHeartbeatProcessState => ({
  heartbeatInFlight: false,
  instanceId: `pinst_${randomBytes(24).toString('hex')}`,
  startPromise: null,
  timer: null,
});

const processState = (): PlatformInstanceHeartbeatProcessState =>
  (heartbeatProcess.__lobehubPlatformInstanceHeartbeatState ??= createProcessState());

export interface PlatformInstanceHeartbeatRuntimeOptions {
  createRepository?: (
    db: LobeChatDatabase,
  ) => Pick<PlatformInstanceRepository, 'registerInstance' | 'upsertHeartbeat'>;
  env?: Record<string, string | undefined>;
  getDatabase?: () => Promise<LobeChatDatabase>;
  logFailure?: (event: { errorClass: string }) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => PlatformInstanceHeartbeatTimer;
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

/** Only persistent production Node processes with an enterprise capability participate. */
export const shouldStartPlatformInstanceHeartbeat = (
  env: Record<string, string | undefined>,
): boolean =>
  env.NODE_ENV === 'production' &&
  env.NEXT_RUNTIME === 'nodejs' &&
  Boolean(env.DATABASE_URL) &&
  !isBuildRuntime(env) &&
  !isEphemeralRuntime(env) &&
  ENTERPRISE_FEATURE_FLAG_KEYS.some((key) => isEnterpriseFlagTruthy(env[key]));

const defaultGetDatabase = async (): Promise<LobeChatDatabase> => {
  const { getServerDB } = await import('@/database/core/db-adaptor');
  return getServerDB();
};

const defaultLogFailure = ({ errorClass }: { errorClass: string }): void => {
  log('heartbeat unavailable errorClass=%s', errorClass);
};

const defaultSchedule = (callback: () => void, delay: number): PlatformInstanceHeartbeatTimer => {
  const timer = setInterval(callback, delay);
  return { clear: () => clearInterval(timer), unref: () => timer.unref() };
};

const errorClassOf = (error: unknown): string =>
  error instanceof Error ? error.name : 'UnknownError';

export const getPlatformInstanceId = (): string => processState().instanceId;

/**
 * Starts at most one process-global heartbeat loop. Unsupported runtimes return before resolving
 * the database module, preserving zero-DB and zero-timer behavior when the feature is off.
 */
export const ensurePlatformInstanceHeartbeatStarted = async (
  options: PlatformInstanceHeartbeatRuntimeOptions = {},
): Promise<boolean> => {
  const env = options.env ?? process.env;
  if (!shouldStartPlatformInstanceHeartbeat(env)) return false;

  const state = processState();
  if (state.timer) return true;
  if (state.startPromise) return state.startPromise;

  const start = async (): Promise<boolean> => {
    const reportFailure = options.logFailure ?? defaultLogFailure;
    const now = options.now ?? Date.now;
    const registerStartedAt = now();
    try {
      const db = await (options.getDatabase ?? defaultGetDatabase)();
      const repository = options.createRepository
        ? options.createRepository(db)
        : new PlatformInstanceRepository(db);
      await repository.registerInstance(state.instanceId);
      observeEnterprisePlatformEvent({
        durationMs: now() - registerStartedAt,
        operation: 'register',
        outcome: 'success',
        type: 'instance_heartbeat',
      });

      const heartbeat = (): void => {
        if (state.heartbeatInFlight) return;
        state.heartbeatInFlight = true;
        const heartbeatStartedAt = now();
        void repository
          .upsertHeartbeat(state.instanceId)
          .then(() => {
            observeEnterprisePlatformEvent({
              durationMs: now() - heartbeatStartedAt,
              operation: 'tick',
              outcome: 'success',
              type: 'instance_heartbeat',
            });
          })
          .catch((error) => {
            observeEnterprisePlatformEvent({
              durationMs: now() - heartbeatStartedAt,
              errorClass: classifyEnterpriseError(error),
              operation: 'tick',
              outcome: 'failure',
              type: 'instance_heartbeat',
            });
            reportFailure({ errorClass: errorClassOf(error) });
          })
          .finally(() => {
            state.heartbeatInFlight = false;
          });
      };
      state.timer = (options.schedule ?? defaultSchedule)(
        heartbeat,
        PLATFORM_INSTANCE_HEARTBEAT_INTERVAL_MS,
      );
      state.timer.unref?.();
      return true;
    } catch (error) {
      observeEnterprisePlatformEvent({
        durationMs: now() - registerStartedAt,
        errorClass: classifyEnterpriseError(error),
        operation: 'register',
        outcome: 'failure',
        type: 'instance_heartbeat',
      });
      reportFailure({ errorClass: errorClassOf(error) });
      return false;
    }
  };

  const startPromise = start();
  state.startPromise = startPromise;
  try {
    return await startPromise;
  } finally {
    if (state.startPromise === startPromise) state.startPromise = null;
  }
};

/** Test-only process restart simulation; production never stops or reuses a retired instance id. */
export const resetPlatformInstanceHeartbeatForTest = (): void => {
  heartbeatProcess.__lobehubPlatformInstanceHeartbeatState?.timer?.clear?.();
  delete heartbeatProcess.__lobehubPlatformInstanceHeartbeatState;
};
