import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { cleanupExpiredIdentityProviderTestAttempts } from '../services/identityProvider/testAttemptStore';

const CLEANUP_INTERVAL_MS = 60 * 1000;

/** Scheduler-compatible, bounded cleanup entry point. */
export const runIdentityProviderTestAttemptCleanup = async (
  db: LobeChatDatabase,
): Promise<number> => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_DATABASE_OIDC) return 0;
  return cleanupExpiredIdentityProviderTestAttempts(db);
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
      await runIdentityProviderTestAttemptCleanup(await getServerDB());
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
