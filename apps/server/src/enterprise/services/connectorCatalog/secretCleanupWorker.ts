import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { isPersistentEnterpriseWorkerRuntime } from '../../jobs/persistentWorkerRuntime';
import type {
  PlatformJobDispatchHandlerContext,
  PlatformJobDispatchHandlerResult,
} from '../../jobs/platformJobsDispatcher';
import {
  ensurePlatformJobsDispatcherStarted,
  resetPlatformJobsDispatcherForTest,
} from '../../jobs/platformJobsDispatcher';
import { PlatformSecretService } from '../../security/secret';
import type { ConnectorCatalogSecretStore } from './catalogTypes';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';
import {
  reconcileConnectorSecretCleanups,
  settleClaimedConnectorSecretCleanup,
} from './secretCleanup';

const DEFAULT_BATCH_SIZE = 50;

/**
 * Env contract for serverless / external schedulers.
 * When set, operators must invoke {@link runConnectorSecretCleanupBatch} on a
 * durable cron/queue (e.g. Vercel Cron → admin/platform route, QStash, k8s CronJob).
 */
export const CONNECTOR_SECRET_CLEANUP_RECONCILE_ENV = 'CONNECTOR_SECRET_CLEANUP_RECONCILE_ENABLED';

/**
 * True when pending `connector.secret.cleanup.v1` jobs can converge without
 * relying solely on the request that enqueued them.
 *
 * - Long-lived Node (Docker/self-hosted production): persistent poller.
 * - Serverless: requires explicit external reconciler opt-in via env.
 * - Non-serverless non-production (local/dev): in-request / test drain is primary.
 */
export const isConnectorSecretCleanupReconcilerConfigured = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean => {
  if (isPersistentEnterpriseWorkerRuntime(env)) return true;
  if (env[CONNECTOR_SECRET_CLEANUP_RECONCILE_ENV] === '1') return true;
  const serverless = Boolean(env.VERCEL || env.VERCEL_ENV || env.AWS_LAMBDA_FUNCTION_NAME);
  return !serverless;
};

/**
 * Build a request-context-free secret store for background drain
 * (same construction as {@link getConnectorOAuthRuntime}).
 */
export const createConnectorSecretCleanupStore = (
  db: LobeChatDatabase,
  env: NodeJS.ProcessEnv = process.env,
): ConnectorCatalogSecretStore | null => {
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) return null;
  let secretService: PlatformSecretService | null;
  try {
    secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(env, flags);
  } catch {
    return null;
  }
  if (!secretService) return null;
  return new PlatformConnectorSecretStore(db, secretService);
};

/**
 * Bounded serverless/cron entrypoint: claim and revoke exact secret refs from
 * durable `connector.secret.cleanup.v1` jobs, then run aged orphan GC.
 */
export const runConnectorSecretCleanupBatch = async (
  db: LobeChatDatabase,
  secrets: ConnectorCatalogSecretStore,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<{ completed: number; failed: number }> =>
  reconcileConnectorSecretCleanups(db, secrets, {
    limit: batchSize,
    workerId: `connector-secret-cleanup-batch:${process.pid}`,
  });

/** Handle one already-claimed `connector.secret.cleanup.v1` job. */
export const handleClaimedConnectorSecretCleanupJob = async (
  ctx: PlatformJobDispatchHandlerContext,
): Promise<PlatformJobDispatchHandlerResult> => {
  const secrets = createConnectorSecretCleanupStore(ctx.db);
  if (!secrets) return { stop: true };
  const outcome = await settleClaimedConnectorSecretCleanup(ctx.db, ctx.job, secrets, ctx.workerId);
  return outcome === 'retry' ? { stop: true } : {};
};

/** Test-only: reset module timer latch between behavioral cases. */
export const __resetConnectorSecretCleanupWorkerForTests = (): void => {
  resetPlatformJobsDispatcherForTest();
};

/** Registers this type with the merged `platform_jobs` dispatcher. */
export const ensureConnectorSecretCleanupWorkerStarted = (): void => {
  if (!isPersistentEnterpriseWorkerRuntime()) return;
  ensurePlatformJobsDispatcherStarted({ extraWorkerName: 'connectorSecretCleanup' });
};
