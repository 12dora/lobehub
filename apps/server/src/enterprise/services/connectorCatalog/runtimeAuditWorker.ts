import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { isPersistentEnterpriseWorkerRuntime } from '../../jobs/persistentWorkerRuntime';
import { appendConnectorRuntimeAudit } from './runtimeAudit';
import { DatabaseConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INTERVAL_MS = 5000;

/**
 * Env contract for serverless / external schedulers.
 * When set, operators must invoke {@link runConnectorRuntimeAuditBatch} on a
 * durable cron/queue (e.g. Vercel Cron → admin/platform route, QStash, k8s CronJob).
 */
export const CONNECTOR_RUNTIME_AUDIT_RECONCILE_ENV = 'CONNECTOR_RUNTIME_AUDIT_RECONCILE_ENABLED';

/**
 * True when pending/expired runtime-audit journal rows can converge without
 * relying solely on the request that produced them.
 *
 * - Long-lived Node (Docker/self-hosted production): persistent poller.
 * - Serverless: requires explicit external reconciler opt-in via env.
 * - Non-serverless non-production (local/dev): in-request delivery is primary;
 *   residual rows are acceptable outside prod serverless.
 */
export const isConnectorRuntimeAuditReconcilerConfigured = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean => {
  if (isPersistentEnterpriseWorkerRuntime(env)) return true;
  if (env[CONNECTOR_RUNTIME_AUDIT_RECONCILE_ENV] === '1') return true;
  const serverless = Boolean(env.VERCEL || env.VERCEL_ENV || env.AWS_LAMBDA_FUNCTION_NAME);
  return !serverless;
};

/**
 * Bounded serverless/cron entrypoint: claim and deliver pending or
 * expired-running connector runtime audit journal rows.
 */
export const runConnectorRuntimeAuditBatch = async (
  db: LobeChatDatabase,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> => {
  const journal = new DatabaseConnectorRuntimeExecutionJournal(db);
  let processed = 0;
  while (processed < batchSize) {
    const claimed = await journal.reconcileNext((entry) => appendConnectorRuntimeAudit(db, entry));
    if (!claimed) break;
    processed += 1;
  }
  return processed;
};

let workerStarted = false;

/** Test-only: reset module timer latch between behavioral cases. */
export const __resetConnectorRuntimeAuditWorkerForTests = (): void => {
  workerStarted = false;
};

/** Starts one non-overlapping poller per process; DB leases coordinate instances. */
export const ensureConnectorRuntimeAuditWorkerStarted = (): void => {
  if (workerStarted || !isPersistentEnterpriseWorkerRuntime()) {
    return;
  }
  workerStarted = true;
  const schedule = () => {
    const timer = setTimeout(run, DEFAULT_INTERVAL_MS);
    timer.unref();
  };
  const run = async () => {
    try {
      const db = await getServerDB();
      await runConnectorRuntimeAuditBatch(db);
    } catch (error) {
      console.error('[connector-runtime-audit-worker] reconciliation failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      schedule();
    }
  };
  void run();
};
