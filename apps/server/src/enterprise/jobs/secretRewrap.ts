import { randomUUID } from 'node:crypto';

import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { parsePlatformKeyProviderName, PlatformSecretService } from '../security/secret';
import { processNextPlatformSecretRewrapBatch } from '../services/secretRewrap';

const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_INTERVAL_MS = 2000;

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

let workerStarted = false;

export const isPlatformSecretRewrapWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean =>
  env.NODE_ENV === 'production' &&
  env.NEXT_RUNTIME !== 'edge' &&
  env.VERCEL !== '1' &&
  !env.VERCEL_ENV &&
  !env.AWS_LAMBDA_FUNCTION_NAME &&
  Boolean(env.DATABASE_URL) &&
  parsePlatformKeyProviderName(env) === 'vault';

/**
 * Persistent Node-process poller only. Serverless/Vercel deployments must use
 * a separate durable worker process and must never start this timer.
 */
export const ensurePlatformSecretRewrapWorkerStarted = (): void => {
  if (workerStarted || !isPlatformSecretRewrapWorkerRuntime()) return;
  workerStarted = true;
  const schedule = () => {
    const timer = setTimeout(run, DEFAULT_INTERVAL_MS);
    timer.unref();
  };
  const run = async () => {
    try {
      const secrets = PlatformSecretService.tryFromEnv(process.env);
      if (!secrets || secrets.keyProviderId !== 'vault') return;
      await runPlatformSecretRewrapBatches(await getServerDB(), secrets);
    } catch (error) {
      console.error('[platform-secret-rewrap-worker] batch failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      schedule();
    }
  };
  void run();
};
