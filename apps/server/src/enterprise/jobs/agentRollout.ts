import { randomUUID } from 'node:crypto';

import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { processNextPlatformAgentRolloutBatch } from '../services/agentCatalog/rolloutService';

const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_INTERVAL_MS = 2000;

/**
 * Process bounded rollout checkpoints. The feature gate is evaluated before the first query, so a
 * disabled deployment performs zero rollout DB reads/writes even if this entry point is invoked.
 */
export const runPlatformAgentRolloutBatches = async (
  db: LobeChatDatabase,
  batchLimit = DEFAULT_BATCH_LIMIT,
): Promise<number> => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AGENTS) return 0;
  let processed = 0;
  while (processed < batchLimit) {
    const result = await processNextPlatformAgentRolloutBatch(
      db,
      `agent-rollout:${process.pid}:${randomUUID()}`,
    );
    if (!result.claimed) break;
    processed += 1;
  }
  return processed;
};

let workerStarted = false;

/** Starts one non-overlapping poller per Node process; M01 leases coordinate multiple instances. */
export const ensurePlatformAgentRolloutWorkerStarted = (): void => {
  if (
    workerStarted ||
    !parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AGENTS ||
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
      await runPlatformAgentRolloutBatches(await getServerDB());
    } catch (error) {
      console.error('[platform-agent-rollout-worker] batch failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      schedule();
    }
  };
  void run();
};
