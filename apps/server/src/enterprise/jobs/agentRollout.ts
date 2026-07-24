import { randomUUID } from 'node:crypto';

import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { processNextPlatformAgentRolloutBatch } from '../services/agentCatalog/rolloutWorker';
import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';

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

export const isPlatformAgentRolloutWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean =>
  isPersistentEnterpriseWorkerRuntime(env) &&
  parseEnterpriseFeatureFlags(env).ENABLE_PLATFORM_MANAGED_AGENTS;

/** Starts one non-overlapping poller per Node process; M01 leases coordinate multiple instances. */
export const ensurePlatformAgentRolloutWorkerStarted = (): void => {
  if (workerStarted || !isPlatformAgentRolloutWorkerRuntime()) return;
  workerStarted = true;
  const schedule = () => {
    const timer = setTimeout(run, DEFAULT_INTERVAL_MS);
    timer.unref();
  };
  const run = async () => {
    try {
      if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AGENTS) return;
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
