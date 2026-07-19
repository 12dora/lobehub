import type { LobeChatDatabase, Transaction } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';

const CLEANUP_INTERVAL_MS = 60 * 1000;
const CLEANUP_LOCK_NAMESPACE = 'aihub:identity-provider-test-attempt-cleanup:v1';

interface IdentityProviderTestAttemptCleanupDependencies {
  acquireDatabase?: () => Promise<LobeChatDatabase>;
  acquireLock?: (tx: Transaction) => Promise<void>;
  cleanup?: (tx: Transaction) => Promise<number>;
}

const acquireDatabase = async (): Promise<LobeChatDatabase> => {
  const { getServerDB } = await import('@/database/core/db-adaptor');
  return getServerDB();
};

const acquireCleanupLock = async (tx: Transaction): Promise<void> => {
  const { sql } = await import('drizzle-orm');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${CLEANUP_LOCK_NAMESPACE})::bigint)`);
};

const cleanupAttempts = async (tx: Transaction): Promise<number> => {
  const { cleanupExpiredIdentityProviderTestAttempts } =
    await import('../services/identityProvider/testAttemptStore');
  return cleanupExpiredIdentityProviderTestAttempts(tx);
};

/** Scheduler-compatible cleanup entry point. Feature-off returns before any DB module is loaded. */
export const runIdentityProviderTestAttemptCleanup = async (
  dependencies: IdentityProviderTestAttemptCleanupDependencies = {},
): Promise<number> => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_DATABASE_OIDC) return 0;
  const db = await (dependencies.acquireDatabase ?? acquireDatabase)();
  return db.transaction(async (tx) => {
    await (dependencies.acquireLock ?? acquireCleanupLock)(tx);
    return (dependencies.cleanup ?? cleanupAttempts)(tx);
  });
};

let workerStarted = false;

/** Starts one non-overlapping reaper in persistent Node deployments. */
export const ensureIdentityProviderTestAttemptCleanupStarted = (): void => {
  if (
    workerStarted ||
    !parseEnterpriseFeatureFlags(process.env).ENABLE_DATABASE_OIDC ||
    process.env.NODE_ENV !== 'production' ||
    process.env.NEXT_RUNTIME !== 'nodejs' ||
    !process.env.DATABASE_URL ||
    process.env.VERCEL_ENV
  ) {
    return;
  }
  workerStarted = true;
  const schedule = () => {
    const timer = setTimeout(run, CLEANUP_INTERVAL_MS);
    timer.unref();
  };
  const run = async () => {
    try {
      await runIdentityProviderTestAttemptCleanup();
    } catch (error) {
      console.error('[identity-provider-test-attempt-reaper] cleanup failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      schedule();
    }
  };
  void run();
};
