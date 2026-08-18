import { randomUUID } from 'node:crypto';

import type { LobeChatDatabase } from '@/database/type';

import { parsePlatformKeyProviderName, PlatformSecretService } from '../security/secret';
import { processNextPlatformSecretRewrapBatch } from '../services/secretRewrap';
import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';
import type { PlatformJobDispatchHandlerContext } from './platformJobsDispatcher';
import { ensurePlatformJobsDispatcherStarted } from './platformJobsDispatcher';

const DEFAULT_BATCH_LIMIT = 10;

/** Run bounded checkpoints with an explicitly supplied Vault-backed service. */
export const runPlatformSecretRewrapBatches = async (
  db: LobeChatDatabase,
  secrets: PlatformSecretService,
  batchLimit = DEFAULT_BATCH_LIMIT,
): Promise<number> => {
  if (secrets.keyProviderId !== 'vault') return 0;
  let processed = 0;
  while (processed < batchLimit) {
    const result = await processNextPlatformSecretRewrapBatch(
      db,
      secrets,
      `secret-rewrap:${process.pid}:${randomUUID()}`,
    );
    if (!result.claimed) break;
    processed += 1;
  }
  return processed;
};

/** Handle one already-claimed `platform.secret.rewrap.v1` job. */
export const handleClaimedPlatformSecretRewrapJob = async (
  ctx: PlatformJobDispatchHandlerContext,
): Promise<void> => {
  const secrets = PlatformSecretService.tryFromEnv(process.env);
  if (!secrets || secrets.keyProviderId !== 'vault') return;
  await processNextPlatformSecretRewrapBatch(ctx.db, secrets, ctx.workerId, {
    claimed: ctx.job,
    leaseMs: ctx.spec.leaseMs,
  });
};

export const isPlatformSecretRewrapWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean =>
  isPersistentEnterpriseWorkerRuntime(env) && parsePlatformKeyProviderName(env) === 'vault';

/**
 * Registers this type with the merged `platform_jobs` dispatcher.
 * Persistent Node-process poller only. Serverless/Vercel deployments must use
 * a separate durable worker process and must never start this timer.
 */
export const ensurePlatformSecretRewrapWorkerStarted = (): void => {
  if (!isPlatformSecretRewrapWorkerRuntime()) return;
  ensurePlatformJobsDispatcherStarted({ extraWorkerName: 'secretRewrap' });
};
