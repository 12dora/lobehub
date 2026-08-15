import { getServerDB } from '@/database/core/db-adaptor';

import { PlatformSecretService } from '../security/secret';
import { AiCatalogSecretManager } from '../services/aiCatalog/secretManager';
import { runSharedOAuthKeepaliveSweep } from '../services/aiCatalog/sharedOAuthKeepalive';
import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';
import { startPersistentWorkerScheduler } from './persistentWorkerScheduler';

/**
 * Timer cadence, NOT the sweep cadence. The hourly rhythm is enforced in the database
 * (`platform_jobs` lease parking), so replicas can poll often without multiplying work —
 * a tick that finds the window closed costs one UPDATE that matches no rows.
 */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

let workerStarted = false;

/**
 * Keep shared (platform) rotating-refresh OAuth connections alive.
 *
 * Persistent Node processes only — serverless deployments must drive
 * {@link runSharedOAuthKeepaliveSweep} from their own durable scheduler, exactly like the
 * secret-rewrap worker.
 */
export const ensureSharedOAuthKeepaliveWorkerStarted = (): void => {
  if (workerStarted || !isPersistentEnterpriseWorkerRuntime()) return;
  workerStarted = true;
  startPersistentWorkerScheduler({
    baseIntervalMs: POLL_INTERVAL_MS,
    namespace: 'shared-oauth-keepalive',
    run: async () => {
      // No platform master key ⇒ no shared vault to keep alive.
      const secrets = PlatformSecretService.tryFromEnv(process.env);
      if (!secrets) return;
      await runSharedOAuthKeepaliveSweep({
        db: await getServerDB(),
        secrets: new AiCatalogSecretManager(secrets),
      });
    },
  });
};
