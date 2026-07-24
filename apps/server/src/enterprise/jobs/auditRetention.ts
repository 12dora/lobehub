import { randomUUID } from 'node:crypto';

import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';

const DEFAULT_BATCH_LIMIT = 5;
const DEFAULT_INTERVAL_MS = 3000;

/** Run bounded retention jobs with an explicitly supplied database. */
export const runPlatformAuditRetentionBatches = async (
  db: LobeChatDatabase,
  batchLimit = DEFAULT_BATCH_LIMIT,
): Promise<number> => {
  // Defense in depth: never touch audit tables when platform admin is closed.
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_ADMIN) return 0;
  // Lazy import so flag-off / serverless processes never load the worker service graph.
  const { runAuditRetentionBatches } = await import('../services/audit/retentionWorker');
  return runAuditRetentionBatches(db, {
    batchLimit,
    workerId: `audit-retention:${process.pid}:${randomUUID()}`,
  });
};

let workerStarted = false;

/** Test-only: reset module timer latch between behavioral cases. */
export const __resetPlatformAuditRetentionWorkerForTests = (): void => {
  workerStarted = false;
};

export const isPlatformAuditRetentionWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean =>
  isPersistentEnterpriseWorkerRuntime(env) &&
  parseEnterpriseFeatureFlags(env).ENABLE_PLATFORM_ADMIN;

/**
 * Persistent Node-process poller only. Serverless/Vercel deployments must use
 * a separate durable worker process and must never start this timer.
 * Requires ENABLE_PLATFORM_ADMIN (default-off).
 */
export const ensurePlatformAuditRetentionWorkerStarted = (): void => {
  if (workerStarted || !isPlatformAuditRetentionWorkerRuntime()) return;
  workerStarted = true;
  const schedule = () => {
    const timer = setTimeout(run, DEFAULT_INTERVAL_MS);
    timer.unref();
  };
  const run = async () => {
    try {
      // Re-check flag each batch so closing the flag stops work without restart.
      if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_ADMIN) return;
      // Lazy DB adaptor: never acquire a connection while the feature is closed.
      const { getServerDB } = await import('@/database/core/db-adaptor');
      await runPlatformAuditRetentionBatches(await getServerDB());
    } catch (error) {
      console.error('[platform-audit-retention-worker] batch failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      schedule();
    }
  };
  void run();
};
