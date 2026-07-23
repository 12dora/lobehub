import { randomUUID } from 'node:crypto';

import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { runAuditExportBatches } from '../services/audit/exportWorker';

const DEFAULT_BATCH_LIMIT = 5;
const DEFAULT_INTERVAL_MS = 3000;

/** Run bounded export jobs with an explicitly supplied database. */
export const runPlatformAuditExportBatches = async (
  db: LobeChatDatabase,
  batchLimit = DEFAULT_BATCH_LIMIT,
): Promise<number> =>
  runAuditExportBatches(db, {
    batchLimit,
    workerId: `audit-export:${process.pid}:${randomUUID()}`,
  });

let workerStarted = false;

export const isPlatformAuditExportWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean =>
  env.NODE_ENV === 'production' &&
  env.NEXT_RUNTIME !== 'edge' &&
  env.VERCEL !== '1' &&
  !env.VERCEL_ENV &&
  !env.AWS_LAMBDA_FUNCTION_NAME &&
  Boolean(env.DATABASE_URL);

/**
 * Persistent Node-process poller only. Serverless/Vercel deployments must use
 * a separate durable worker process and must never start this timer.
 */
export const ensurePlatformAuditExportWorkerStarted = (): void => {
  if (workerStarted || !isPlatformAuditExportWorkerRuntime()) return;
  workerStarted = true;
  const schedule = () => {
    const timer = setTimeout(run, DEFAULT_INTERVAL_MS);
    timer.unref();
  };
  const run = async () => {
    try {
      await runPlatformAuditExportBatches(await getServerDB());
    } catch (error) {
      console.error('[platform-audit-export-worker] batch failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      schedule();
    }
  };
  void run();
};
