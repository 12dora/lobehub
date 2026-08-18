import { randomUUID } from 'node:crypto';

import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';
import type { PlatformJobDispatchHandlerContext } from './platformJobsDispatcher';
import {
  ensurePlatformJobsDispatcherStarted,
  resetPlatformJobsDispatcherForTest,
} from './platformJobsDispatcher';

const DEFAULT_BATCH_LIMIT = 5;

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

/** Handle one already-claimed `platform.audit.retention.v1` job. */
export const handleClaimedPlatformAuditRetentionJob = async (
  ctx: PlatformJobDispatchHandlerContext,
): Promise<void> => {
  const { processNextAuditRetentionJob } = await import('../services/audit/retentionWorker');
  await processNextAuditRetentionJob(ctx.db, {
    claimed: ctx.job,
    leaseMs: ctx.spec.leaseMs,
    workerId: ctx.workerId,
  });
};

/** Test-only: reset module timer latch between behavioral cases. */
export const __resetPlatformAuditRetentionWorkerForTests = (): void => {
  resetPlatformJobsDispatcherForTest();
};

export const isPlatformAuditRetentionWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean =>
  isPersistentEnterpriseWorkerRuntime(env) &&
  parseEnterpriseFeatureFlags(env).ENABLE_PLATFORM_ADMIN;

/**
 * Registers this type with the merged `platform_jobs` dispatcher.
 * Persistent Node-process poller only. Serverless/Vercel deployments must use
 * a separate durable worker process and must never start this timer.
 * Requires ENABLE_PLATFORM_ADMIN (default-off).
 */
export const ensurePlatformAuditRetentionWorkerStarted = (): void => {
  if (!isPlatformAuditRetentionWorkerRuntime()) return;
  ensurePlatformJobsDispatcherStarted({ extraWorkerName: 'auditRetention' });
};
