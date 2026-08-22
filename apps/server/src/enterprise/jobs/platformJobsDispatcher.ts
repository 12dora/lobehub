import { randomUUID } from 'node:crypto';

import type { PlatformModuleId } from '@/const/platform/modules';
import { PlatformJobModel } from '@/database/models/platform/job';
import type { PlatformJobItem } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { parsePlatformKeyProviderName } from '../security/secret/config';
import { isBootModuleEnabled } from '../services/moduleSettings';
import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';
import type { PersistentWorkerScheduler } from './persistentWorkerScheduler';
import {
  calculatePersistentWorkerRetryDelay,
  startPersistentWorkerScheduler,
} from './persistentWorkerScheduler';

export interface PlatformJobDispatchSpec {
  batchLimit: number;
  intervalMs: number;
  jobType: string;
  leaseMs: number;
  moduleId?: PlatformModuleId;
  workerName: string;
}

export interface PlatformJobDispatchHandlerContext {
  db: LobeChatDatabase;
  job: PlatformJobItem;
  spec: PlatformJobDispatchSpec;
  workerId: string;
}

export interface PlatformJobDispatchHandlerResult {
  /** Stop this type's lane for the rest of the tick (old cleanup `retry` break). */
  stop?: boolean;
}

export type PlatformJobDispatchHandler = (
  ctx: PlatformJobDispatchHandlerContext,
) => Promise<PlatformJobDispatchHandlerResult | void>;

/**
 * The six `platform_jobs` pollers folded into one loop. Worker names stay
 * aligned with `PLATFORM_MODULES[*].workers` so the modules page listing
 * does not change.
 */
export const PLATFORM_JOB_DISPATCH_SPECS = [
  {
    batchLimit: 5,
    intervalMs: 3000,
    jobType: 'platform.audit.export.v1',
    leaseMs: 60_000,
    moduleId: 'audit',
    workerName: 'auditExport',
  },
  {
    batchLimit: 5,
    intervalMs: 3000,
    jobType: 'platform.audit.retention.v1',
    leaseMs: 60_000,
    moduleId: 'audit',
    workerName: 'auditRetention',
  },
  {
    batchLimit: 10,
    intervalMs: 2000,
    jobType: 'platform.agent.rollout.v1',
    leaseMs: 60_000,
    moduleId: 'managedAgents',
    workerName: 'agentRollout',
  },
  {
    batchLimit: 25,
    intervalMs: 5000,
    jobType: 'connector.runtime.shared-call.v1',
    leaseMs: 30_000,
    moduleId: 'managedConnectors',
    workerName: 'connectorRuntimeAudit',
  },
  {
    batchLimit: 50,
    intervalMs: 5000,
    jobType: 'connector.secret.cleanup.v1',
    leaseMs: 30_000,
    moduleId: 'managedConnectors',
    workerName: 'connectorSecretCleanup',
  },
  {
    batchLimit: 10,
    intervalMs: 2000,
    jobType: 'platform.secret.rewrap.v1',
    leaseMs: 60_000,
    workerName: 'secretRewrap',
  },
  {
    batchLimit: 2,
    intervalMs: 2000,
    jobType: 'platform.document.render.v1',
    leaseMs: 180_000,
    workerName: 'documentRender',
  },
] as const satisfies readonly PlatformJobDispatchSpec[];

const isSecretRewrapEnabled = (env: Record<string, string | undefined>): boolean => {
  try {
    return parsePlatformKeyProviderName(env) === 'vault';
  } catch {
    return false;
  }
};

/** Boot-module view plus the Vault predicate for secretRewrap. */
export const resolveEnabledPlatformJobTypes = (
  isEnabled: (id: PlatformModuleId) => boolean = isBootModuleEnabled,
  env: Record<string, string | undefined> = process.env,
): PlatformJobDispatchSpec[] =>
  PLATFORM_JOB_DISPATCH_SPECS.filter((spec) => {
    const moduleId = 'moduleId' in spec ? spec.moduleId : undefined;
    if (moduleId && !isEnabled(moduleId)) return false;
    if (spec.workerName === 'secretRewrap') return isSecretRewrapEnabled(env);
    return true;
  });

const defaultHandleClaimed: PlatformJobDispatchHandler = async (ctx) => {
  switch (ctx.spec.workerName) {
    case 'auditExport': {
      const { handleClaimedPlatformAuditExportJob } = await import('./auditExport');
      return handleClaimedPlatformAuditExportJob(ctx);
    }
    case 'auditRetention': {
      const { handleClaimedPlatformAuditRetentionJob } = await import('./auditRetention');
      return handleClaimedPlatformAuditRetentionJob(ctx);
    }
    case 'agentRollout': {
      const { handleClaimedPlatformAgentRolloutJob } = await import('./agentRollout');
      return handleClaimedPlatformAgentRolloutJob(ctx);
    }
    case 'connectorRuntimeAudit': {
      const { handleClaimedConnectorRuntimeAuditJob } =
        await import('../services/connectorCatalog/runtimeAuditWorker');
      return handleClaimedConnectorRuntimeAuditJob(ctx);
    }
    case 'connectorSecretCleanup': {
      const { handleClaimedConnectorSecretCleanupJob } =
        await import('../services/connectorCatalog/secretCleanupWorker');
      return handleClaimedConnectorSecretCleanupJob(ctx);
    }
    case 'secretRewrap': {
      const { handleClaimedPlatformSecretRewrapJob } = await import('./secretRewrap');
      return handleClaimedPlatformSecretRewrapJob(ctx);
    }
    case 'documentRender': {
      const { handleClaimedDocumentRenderJob } = await import('./documentRender');
      return handleClaimedDocumentRenderJob(ctx);
    }
    default: {
      return;
    }
  }
};

export interface RunPlatformJobsDispatchTickParams {
  cleanupExpiredReservation?: () => Promise<boolean>;
  db: LobeChatDatabase;
  enabledTypes: readonly PlatformJobDispatchSpec[];
  handleClaimed?: PlatformJobDispatchHandler;
  isTypeRunnable?: (spec: PlatformJobDispatchSpec, db: LobeChatDatabase) => Promise<boolean>;
  jobs?: Pick<PlatformJobModel, 'claimBatch'>;
  now?: () => number;
  onAfterDispatch?: (enabled: readonly PlatformJobDispatchSpec[]) => Promise<void>;
  workerId: string;
}

const defaultIsTypeRunnable = async (
  spec: PlatformJobDispatchSpec,
  db: LobeChatDatabase,
): Promise<boolean> => {
  if (spec.workerName === 'secretRewrap') {
    const { PlatformSecretService } = await import('../security/secret');
    const secrets = PlatformSecretService.tryFromEnv(process.env);
    return Boolean(secrets && secrets.keyProviderId === 'vault');
  }
  if (spec.workerName === 'connectorSecretCleanup') {
    const { createConnectorSecretCleanupStore } =
      await import('../services/connectorCatalog/secretCleanupWorker');
    return Boolean(createConnectorSecretCleanupStore(db));
  }
  return true;
};

const claimOneOfType = async (
  jobs: Pick<PlatformJobModel, 'claimBatch'>,
  spec: PlatformJobDispatchSpec,
  workerId: string,
): Promise<PlatformJobItem | undefined> => {
  const [claimed] = await jobs.claimBatch({
    leaseMsByType: { [spec.jobType]: spec.leaseMs },
    limitByType: { [spec.jobType]: 1 },
    types: [spec.jobType],
    workerId,
  });
  return claimed;
};

/**
 * One job at a time, matching the old `claimNext` loops. The mixed first
 * claim already looked at an empty type — do not issue a second query for it.
 */
const runTypeLane = async (params: {
  db: LobeChatDatabase;
  first: PlatformJobItem | undefined;
  handle: PlatformJobDispatchHandler;
  jobs: Pick<PlatformJobModel, 'claimBatch'>;
  now: () => number;
  spec: PlatformJobDispatchSpec;
  workerId: string;
}): Promise<boolean> => {
  const { db, handle, jobs, now, spec, workerId } = params;
  let current = params.first;
  let processed = 0;
  let didWork = false;
  while (processed < spec.batchLimit) {
    if (!current) {
      if (processed === 0) break;
      try {
        current = await claimOneOfType(jobs, spec, workerId);
      } catch (error) {
        console.error('[platformJobsDispatcher] claim failed', {
          errorClass: error instanceof Error ? error.name : 'UnknownError',
          type: spec.jobType,
        });
        noteTypeFailure(spec, now());
        return didWork;
      }
      if (!current) break;
    }
    const job = current;
    current = undefined;
    processed += 1;
    didWork = true;
    try {
      const result = await handle({ db, job, spec, workerId });
      if (result?.stop) {
        noteTypeSuccess(spec.jobType);
        return didWork;
      }
    } catch (error) {
      console.error('[platformJobsDispatcher] handler failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        type: spec.jobType,
      });
      noteTypeFailure(spec, now());
      return didWork;
    }
  }
  noteTypeSuccess(spec.jobType);
  return didWork;
};

/**
 * Readiness-gated mixed claim (cap 1 per type, one statement), then
 * independent serial lanes via `Promise.allSettled`. Each lane processes
 * its job then claims the next one until empty or `batchLimit`.
 */
export const runPlatformJobsDispatchTick = async (
  params: RunPlatformJobsDispatchTickParams,
): Promise<{ didWork: boolean }> => {
  const enabled = params.enabledTypes;
  if (enabled.length === 0) return { didWork: false };

  let didWork = false;
  const now = params.now ?? Date.now;
  const nowMs = now();
  const isRunnable = params.isTypeRunnable ?? defaultIsTypeRunnable;
  const runnable: PlatformJobDispatchSpec[] = [];
  for (const spec of enabled) {
    if (isTypeInBackoff(spec.jobType, nowMs)) continue;
    try {
      if (spec.workerName === 'connectorRuntimeAudit') {
        const cleaned = params.cleanupExpiredReservation
          ? await params.cleanupExpiredReservation()
          : await (async () => {
              const { DatabaseConnectorRuntimeExecutionJournal } =
                await import('../services/connectorCatalog/runtimeExecutionJournal');
              return new DatabaseConnectorRuntimeExecutionJournal(
                params.db,
              ).cleanupExpiredReservation();
            })();
        if (cleaned) didWork = true;
      }
      if (await isRunnable(spec, params.db)) runnable.push(spec);
    } catch (error) {
      console.error('[platformJobsDispatcher] readiness failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        type: spec.jobType,
      });
      noteTypeFailure(spec, now());
    }
  }
  if (runnable.length === 0) return { didWork: didWork || hasPendingRetry(now()) };

  const model = params.jobs ?? new PlatformJobModel(params.db);
  const jobs = { claimBatch: model.claimBatch.bind(model) };
  // Idle: one mixed claim, cap 1 per type. Busy lanes then claimNext-style
  // one more row at a time up to the old per-type batchLimit.
  let firstWave: PlatformJobItem[];
  try {
    firstWave = await jobs.claimBatch({
      leaseMsByType: Object.fromEntries(runnable.map((spec) => [spec.jobType, spec.leaseMs])),
      limitByType: Object.fromEntries(runnable.map((spec) => [spec.jobType, 1])),
      types: runnable.map((spec) => spec.jobType),
      workerId: params.workerId,
    });
  } catch (error) {
    console.error('[platformJobsDispatcher] claim failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      types: runnable.map((spec) => spec.jobType),
    });
    const failedAt = now();
    for (const spec of runnable) noteTypeFailure(spec, failedAt);
    return { didWork: didWork || hasPendingRetry(now()) };
  }
  if (firstWave.length > 0) didWork = true;

  const handle = params.handleClaimed ?? defaultHandleClaimed;
  const firstByType = new Map(firstWave.map((job) => [job.type, job]));

  const laneResults = await Promise.allSettled(
    runnable.map(async (spec) =>
      runTypeLane({
        db: params.db,
        first: firstByType.get(spec.jobType),
        handle,
        jobs,
        now,
        spec,
        workerId: params.workerId,
      }),
    ),
  );
  for (const result of laneResults) {
    if (result.status === 'fulfilled' && result.value) didWork = true;
    if (result.status === 'rejected') {
      console.error('[platformJobsDispatcher] lane failed', {
        errorClass: result.reason instanceof Error ? result.reason.name : 'UnknownError',
      });
    }
  }

  if (params.onAfterDispatch) {
    await params.onAfterDispatch(runnable);
  } else if (runnable.some((spec) => spec.workerName === 'connectorSecretCleanup')) {
    const { createConnectorSecretCleanupStore } =
      await import('../services/connectorCatalog/secretCleanupWorker');
    const { maybeRunConnectorSecretOrphanGc } =
      await import('../services/connectorCatalog/secretCleanup');
    const secrets = createConnectorSecretCleanupStore(params.db);
    if (secrets) await maybeRunConnectorSecretOrphanGc(secrets);
  }

  // While any lane has a future retryAt, report work so the shared idle
  // backoff cannot push the next tick past that retry. The scheduler has no
  // other wake-up hook; this keeps the loop at baseIntervalMs.
  return { didWork: didWork || hasPendingRetry(now()) };
};

let dispatcherStarted = false;
let dispatcherScheduler: PersistentWorkerScheduler | undefined;
const extraWorkerNames = new Set<string>();

/**
 * Per-type consecutive-failure backoff with an absolute `retryAt`.
 * A type is claimed only when `now >= retryAt`.
 */
const laneFailures = new Map<string, { consecutive: number; retryAt: number }>();

const isTypeInBackoff = (jobType: string, nowMs: number): boolean => {
  const state = laneFailures.get(jobType);
  return Boolean(state && nowMs < state.retryAt);
};

const hasPendingRetry = (nowMs: number): boolean =>
  [...laneFailures.values()].some((state) => state.retryAt > nowMs);

const noteTypeSuccess = (jobType: string): void => {
  laneFailures.delete(jobType);
};

/**
 * Record a per-type failure at `nowMs` — the catch clock, not tick start —
 * so time spent in the probe/handler does not consume the delay.
 * `retryAt = nowMs + calculatePersistentWorkerRetryDelay(type.interval, failures)`
 * (same ±20% jitter as the old per-worker scheduler).
 *
 * Retries are rounded up to the next dispatcher tick: the shared loop is one
 * timer at `baseIntervalMs` and does not grow a variable next-delay hook. A
 * 4.4s retry on a 2s dispatcher therefore fires at the 6s tick — never earlier
 * than intended, at most one base interval late. Per-replica process start
 * time still phase-offsets that grid, so replicas do not retry in lockstep.
 */
const noteTypeFailure = (spec: PlatformJobDispatchSpec, nowMs: number): void => {
  const consecutive = (laneFailures.get(spec.jobType)?.consecutive ?? 0) + 1;
  const retryAt = nowMs + calculatePersistentWorkerRetryDelay(spec.intervalMs, consecutive);
  laneFailures.set(spec.jobType, { consecutive, retryAt });
};

/**
 * Run a dispatch tick now instead of waiting out the idle backoff (up to 60s).
 * Called right after enqueueing latency-sensitive jobs (document render: the
 * user usually sends a message seconds after the upload).
 */
export const wakePlatformJobsDispatcher = (): void => {
  dispatcherScheduler?.wake();
};

/** Test-only: drop the process-once latch and stop the loop. */
export const resetPlatformJobsDispatcherForTest = (): void => {
  dispatcherScheduler?.stop();
  dispatcherScheduler = undefined;
  dispatcherStarted = false;
  extraWorkerNames.clear();
  laneFailures.clear();
};

const unionEnabledTypes = (
  fromBoot: readonly PlatformJobDispatchSpec[],
): PlatformJobDispatchSpec[] => {
  if (extraWorkerNames.size === 0) return [...fromBoot];
  const byType = new Map(fromBoot.map((item) => [item.jobType, item]));
  for (const spec of PLATFORM_JOB_DISPATCH_SPECS) {
    if (extraWorkerNames.has(spec.workerName)) byType.set(spec.jobType, spec);
  }
  return [...byType.values()];
};

/**
 * Starts at most one scheduler at `min(interval)` of the enabled types.
 * An empty enable-set starts nothing (no timer, no DB).
 * `extraWorkerName` lets a virtual `ensure*` start the loop even when the
 * boot-module view is empty (test setup forces `ENABLE_*=0`).
 */
export const ensurePlatformJobsDispatcherStarted = (
  options: {
    enabledTypes?: readonly PlatformJobDispatchSpec[];
    env?: Partial<NodeJS.ProcessEnv>;
    extraWorkerName?: string;
    runTick?: typeof runPlatformJobsDispatchTick;
  } = {},
): void => {
  if (options.extraWorkerName) extraWorkerNames.add(options.extraWorkerName);
  if (dispatcherStarted) return;
  if (!isPersistentEnterpriseWorkerRuntime(options.env ?? process.env)) return;

  const resolveEnabled = () =>
    unionEnabledTypes(options.enabledTypes ?? resolveEnabledPlatformJobTypes());
  const enabled = resolveEnabled();
  if (enabled.length === 0) return;

  dispatcherStarted = true;
  const workerId = `platform-jobs:${process.pid}:${randomUUID()}`;
  const baseIntervalMs = Math.min(...enabled.map((spec) => spec.intervalMs));
  dispatcherScheduler = startPersistentWorkerScheduler({
    baseIntervalMs,
    namespace: 'platform-jobs',
    run: async () => {
      const live = resolveEnabled();
      if (live.length === 0) return { didWork: false };
      const { getServerDB } = await import('@/database/core/db-adaptor');
      return (options.runTick ?? runPlatformJobsDispatchTick)({
        db: await getServerDB(),
        enabledTypes: live,
        workerId,
      });
    },
  });
};
