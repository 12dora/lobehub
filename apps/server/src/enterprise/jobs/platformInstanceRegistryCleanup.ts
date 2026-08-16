import type { LobeChatDatabase, Transaction } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_LOCK_NAMESPACE = 'aihub:platform-instance-registry-cleanup:v1';
/** Rows are process-registration history; anything older than this is operationally meaningless. */
export const PLATFORM_INSTANCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 500;
const CLEANUP_MAX_PASSES = 20;

export interface PlatformInstanceRegistryCleanupResult {
  identityInstances: number;
  platformInstances: number;
  restartRequests: number;
}

interface PlatformInstanceRegistryCleanupDependencies {
  acquireDatabase?: () => Promise<LobeChatDatabase>;
  acquireLock?: (tx: Transaction) => Promise<void>;
  /** One bounded pass; the caller loops until a pass deletes nothing. */
  cleanup?: (tx: Transaction, cutoff: Date) => Promise<PlatformInstanceRegistryCleanupResult>;
  now?: () => Date;
}

const acquireDatabase = async (): Promise<LobeChatDatabase> => {
  const { getServerDB } = await import('@/database/core/db-adaptor');
  return getServerDB();
};

/**
 * Reaper-owned mutex plus the identity convergence lock. Taking the convergence lock in the same
 * order as instance registration / heartbeat keeps those writers and this reaper deadlock-free.
 */
const acquireCleanupLock = async (tx: Transaction): Promise<void> => {
  const { sql } = await import('drizzle-orm');
  const { acquireIdentityProviderConvergenceLock } =
    await import('../services/identityProvider/instanceRegistry');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${CLEANUP_LOCK_NAMESPACE})::bigint)`);
  await acquireIdentityProviderConvergenceLock(tx);
};

/** Instance ids owned by this process — never eligible for deletion, whatever the cutoff says. */
const localInstanceIds = async (): Promise<string[]> => {
  const [{ getIdentityProviderProcessInstance }, { getPlatformInstanceId }] = await Promise.all([
    import('../services/identityProvider/instanceRegistry'),
    import('../services/platformInstance/heartbeatRuntime'),
  ]);
  return [getIdentityProviderProcessInstance().instanceId, getPlatformInstanceId()];
};

/** Resolves modules and local ids up front so no import happens while the locks are held. */
const purgeRegistry = async (): Promise<
  (tx: Transaction, cutoff: Date) => Promise<PlatformInstanceRegistryCleanupResult>
> => {
  const { PlatformInstanceRepository } = await import('@/database/repositories/platformInstance');
  const keepInstanceIds = await localInstanceIds();
  return (tx, cutoff) =>
    new PlatformInstanceRepository(tx).purgeOfflineInstances({
      cutoff,
      keepInstanceIds,
      limit: CLEANUP_BATCH_SIZE,
    });
};

/**
 * Scheduler-compatible cleanup entry point. Feature-off returns before any DB module is loaded.
 * Each pass is its own short transaction so the convergence lock is never held across the
 * whole backlog.
 */
export const runPlatformInstanceRegistryCleanup = async (
  dependencies: PlatformInstanceRegistryCleanupDependencies = {},
): Promise<PlatformInstanceRegistryCleanupResult> => {
  const empty: PlatformInstanceRegistryCleanupResult = {
    identityInstances: 0,
    platformInstances: 0,
    restartRequests: 0,
  };
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_DATABASE_OIDC) return empty;
  const db = await (dependencies.acquireDatabase ?? acquireDatabase)();
  const now = dependencies.now ?? (() => new Date());
  const cleanup = dependencies.cleanup ?? (await purgeRegistry());
  const total = { ...empty };
  for (let pass = 0; pass < CLEANUP_MAX_PASSES; pass += 1) {
    const cutoff = new Date(now().getTime() - PLATFORM_INSTANCE_RETENTION_MS);
    const deleted = await db.transaction(async (tx) => {
      await (dependencies.acquireLock ?? acquireCleanupLock)(tx);
      return cleanup(tx, cutoff);
    });
    total.identityInstances += deleted.identityInstances;
    total.platformInstances += deleted.platformInstances;
    total.restartRequests += deleted.restartRequests;
    if (
      deleted.identityInstances === 0 &&
      deleted.platformInstances === 0 &&
      deleted.restartRequests === 0
    ) {
      break;
    }
  }
  return total;
};

let workerStarted = false;

export const isPlatformInstanceRegistryCleanupWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean =>
  isPersistentEnterpriseWorkerRuntime(env) && parseEnterpriseFeatureFlags(env).ENABLE_DATABASE_OIDC;

/** Starts one non-overlapping reaper in persistent Node deployments (never AWS Lambda). */
export const ensurePlatformInstanceRegistryCleanupStarted = (): void => {
  if (workerStarted || !isPlatformInstanceRegistryCleanupWorkerRuntime()) return;
  workerStarted = true;
  const schedule = () => {
    const timer = setTimeout(run, CLEANUP_INTERVAL_MS);
    timer.unref();
  };
  const run = async () => {
    try {
      await runPlatformInstanceRegistryCleanup();
    } catch (error) {
      console.error('[platform-instance-registry-reaper] cleanup failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      schedule();
    }
  };
  void run();
};
