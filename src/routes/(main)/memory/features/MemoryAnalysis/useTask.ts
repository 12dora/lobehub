import { AsyncTaskStatus } from '@lobechat/types';

import { useClientDataSWR } from '@/libs/swr';
import { userMemoryKeys } from '@/libs/swr/keys';
import { type MemoryExtractionTask } from '@/services/userMemory/extraction';
import { memoryExtractionService } from '@/services/userMemory/extraction';

export const useMemoryAnalysisAsyncTask = (taskId?: string) => {
  const swr = useClientDataSWR<MemoryExtractionTask | null>(
    taskId ? userMemoryKeys.analysisTask(taskId) : userMemoryKeys.analysisTask(),
    () => memoryExtractionService.getTask(taskId),
    {
      // Single source of polling. There used to be a second 5s `setInterval`
      // calling `mutate()` on top of this, which doubled up on every 30s tick;
      // the SWR refresh now owns the whole cadence at the faster interval.
      refreshInterval: (data) =>
        data && [AsyncTaskStatus.Pending, AsyncTaskStatus.Processing].includes(data.status)
          ? 5000
          : 0,
    },
  );

  return {
    ...swr,
    refresh: swr.mutate,
  };
};
