import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { appendConnectorRuntimeAudit } from './runtimeAudit';
import { DatabaseConnectorRuntimeExecutionJournal } from './runtimeExecutionJournal';

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INTERVAL_MS = 5000;

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

/** Starts one non-overlapping poller per process; DB leases coordinate instances. */
export const ensureConnectorRuntimeAuditWorkerStarted = (): void => {
  if (
    workerStarted ||
    process.env.NODE_ENV !== 'production' ||
    process.env.NEXT_RUNTIME !== 'nodejs' ||
    !process.env.DATABASE_URL ||
    process.env.VERCEL_ENV
  ) {
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
