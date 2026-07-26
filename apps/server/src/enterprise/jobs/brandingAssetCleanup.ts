import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { AdminBrandingAssetService } from '../services/branding';
import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';
import { startPersistentWorkerScheduler } from './persistentWorkerScheduler';

const BATCH_LIMIT = 50;
const INTERVAL_MS = 5 * 60 * 1000;

export const runBrandingAssetCleanupBatch = async (
  db: LobeChatDatabase,
  service: Pick<
    AdminBrandingAssetService,
    'isStorageConfigured' | 'sweep'
  > = new AdminBrandingAssetService(db),
): Promise<{ deleted: number; failed: number; scanned: number }> => {
  if (!service.isStorageConfigured()) return { deleted: 0, failed: 0, scanned: 0 };
  const result = await service.sweep({ limit: BATCH_LIMIT });
  if (result.failed > 0) throw new Error('Branding asset cleanup batch failed');
  return result;
};

let workerStarted = false;

export const ensureBrandingAssetCleanupWorkerStarted = (): void => {
  if (workerStarted || !isPersistentEnterpriseWorkerRuntime()) return;
  workerStarted = true;
  startPersistentWorkerScheduler({
    baseIntervalMs: INTERVAL_MS,
    namespace: 'branding-asset-cleanup',
    run: async () => {
      await runBrandingAssetCleanupBatch(await getServerDB());
    },
  });
};
