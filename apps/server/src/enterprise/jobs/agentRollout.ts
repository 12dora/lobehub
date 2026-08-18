import { randomUUID } from 'node:crypto';

import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { processNextPlatformAgentRolloutBatch } from '../services/agentCatalog/rolloutWorker';
import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';
import type { PlatformJobDispatchHandlerContext } from './platformJobsDispatcher';
import { ensurePlatformJobsDispatcherStarted } from './platformJobsDispatcher';

const DEFAULT_BATCH_LIMIT = 10;

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

/** Handle one already-claimed `platform.agent.rollout.v1` job. */
export const handleClaimedPlatformAgentRolloutJob = async (
  ctx: PlatformJobDispatchHandlerContext,
): Promise<void> => {
  await processNextPlatformAgentRolloutBatch(ctx.db, ctx.workerId, {
    claimed: ctx.job,
    leaseMs: ctx.spec.leaseMs,
  });
};

export const isPlatformAgentRolloutWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean =>
  isPersistentEnterpriseWorkerRuntime(env) &&
  parseEnterpriseFeatureFlags(env).ENABLE_PLATFORM_MANAGED_AGENTS;

/** Registers this type with the merged `platform_jobs` dispatcher. */
export const ensurePlatformAgentRolloutWorkerStarted = (): void => {
  if (!isPlatformAgentRolloutWorkerRuntime()) return;
  ensurePlatformJobsDispatcherStarted({ extraWorkerName: 'agentRollout' });
};
