'use client';

import { useCallback, useRef, useState } from 'react';
import useSWRInfinite from 'swr/infinite';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminSystemJobAction } from '@/enterprise/client/features/admin/system/controller';
import {
  adminSystemJobsChanged,
  canRunAdminSystemJobAction,
  classifyAdminSystemJobsError,
  collectAdminSystemJobs,
  didAdminSystemJobRefreshConfirm,
  hasActiveAdminSystemJobs,
  isAdminSystemConflictError,
  isAdminSystemInvalidInputError,
  isAdminSystemJobMutationAuthoritative,
  resetAdminSystemJobPages,
  shouldPollAdminSystemJobs,
} from '@/enterprise/client/features/admin/system/controller';
import type {
  AdminSystemGetInstanceRevisionsInput,
  AdminSystemInstanceRevisions,
  AdminSystemJob,
  AdminSystemJobs,
  AdminSystemService,
} from '@/enterprise/client/services/adminSystem';
import { useClientDataSWR } from '@/libs/swr';

import {
  buildAdminSystemInstancesKey,
  buildAdminSystemJobsKey,
  buildAdminSystemJobsPollKey,
  buildAdminSystemStatusKey,
} from '../swrKeys';

const DEFAULT_PAGE_SIZE = 50;
const ACTIVE_JOB_POLL_INTERVAL_MS = 3000;

export const useAdminSystemStatus = (enabled: boolean, service: AdminSystemService) =>
  useClientDataSWR(buildAdminSystemStatusKey(enabled), () => service.getStatus(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

export interface AdminSystemInstancesState {
  backgroundError: unknown;
  data?: AdminSystemInstanceRevisions;
  hasMore: boolean;
  initialError: unknown;
  isLoadingInitial: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  loadMoreError: boolean;
  refresh: () => Promise<AdminSystemInstanceRevisions[] | undefined>;
  retryLoadMore: () => void;
}

export const useAdminSystemInstances = (
  enabled: boolean,
  service: AdminSystemService,
  input: AdminSystemGetInstanceRevisionsInput = { limit: 50 },
): AdminSystemInstancesState => {
  const swr = useSWRInfinite<AdminSystemInstanceRevisions>(
    (index, previous: AdminSystemInstanceRevisions | null) => {
      if (!enabled) return null;
      if (previous && previous.nextCursor === null) return null;
      const cursor = index === 0 ? input?.cursor : (previous?.nextCursor ?? undefined);
      return buildAdminSystemInstancesKey({ ...input, cursor }, enabled);
    },
    ([, pageInput]: readonly [string, AdminSystemGetInstanceRevisionsInput]) =>
      service.getInstanceRevisions(pageInput),
    { revalidateFirstPage: false, revalidateOnFocus: false },
  );
  const pages = swr.data ?? [];
  const loadedPages = swr.data?.length ?? 0;
  const settled = swr.data !== undefined;
  // Bind accumulated pages to the first page's targetRevision. A mid-pagination
  // publish changes the fingerprint — drop later pages so rows are not mixed
  // across independent convergence snapshots.
  const anchorTargetRevision = pages[0]?.targetRevision;
  const consistentPages =
    anchorTargetRevision === undefined
      ? pages
      : pages.filter((page) => page.targetRevision === anchorTargetRevision);
  const targetRevisionDrift = consistentPages.length < pages.length;
  const seen = new Set<string>();
  const items = consistentPages.flatMap((page) =>
    page.items.filter((instance) => {
      if (seen.has(instance.instanceId)) return false;
      seen.add(instance.instanceId);
      return true;
    }),
  );
  const data = consistentPages[0] ? { ...consistentPages[0], items } : undefined;
  const errorPhase = classifyAdminSystemJobsError({
    error: swr.error,
    loadedPages,
    requestedPages: swr.size,
    settled,
  });
  const reachedEnd =
    !targetRevisionDrift && loadedPages > 0 && consistentPages.at(-1)?.nextCursor === null;

  return {
    backgroundError: errorPhase === 'background' ? swr.error : undefined,
    data,
    hasMore: enabled && loadedPages > 0 && !reachedEnd && !targetRevisionDrift,
    initialError: errorPhase === 'initial' ? swr.error : undefined,
    isLoadingInitial: enabled && !settled && swr.isValidating,
    isLoadingMore: swr.isValidating && loadedPages > 0 && swr.size > loadedPages,
    loadMore: () => void swr.setSize((size) => size + 1),
    loadMoreError:
      (errorPhase === 'load_more' && !swr.isValidating) ||
      (targetRevisionDrift && !swr.isValidating),
    refresh: () => swr.mutate(),
    retryLoadMore: () => {
      // Target-bound cursor rejected (or a successfully returned later page drifted):
      // re-sending the same cursor loops forever. Restart from page one.
      const cursorInvalidated =
        targetRevisionDrift ||
        (errorPhase === 'load_more' && isAdminSystemInvalidInputError(swr.error));
      if (cursorInvalidated) {
        void (async () => {
          await swr.setSize(1);
          await swr.mutate();
        })();
        return;
      }
      void swr.setSize(swr.size);
    },
  };
};

export interface AdminSystemJobsState {
  applyStagedUpdate: () => Promise<void>;
  backgroundError: unknown;
  hasActiveJobs: boolean;
  hasMore: boolean;
  hasStagedUpdate: boolean;
  initialError: unknown;
  isLoadingInitial: boolean;
  isLoadingMore: boolean;
  jobs: AdminSystemJob[];
  loadMore: () => void;
  loadMoreError: boolean;
  pollError: unknown;
  refresh: () => Promise<AdminSystemJobs[] | undefined>;
  retryLoadMore: () => void;
}

export const useAdminSystemJobs = (
  enabled: boolean,
  service: AdminSystemService,
  options: {
    authoritativeActiveCount?: number | null;
    refreshAuthority: () => Promise<unknown>;
  },
  limit = DEFAULT_PAGE_SIZE,
): AdminSystemJobsState => {
  const [stagedFirstPage, setStagedFirstPage] = useState<AdminSystemJobs | null>(null);
  const swr = useSWRInfinite<AdminSystemJobs>(
    (index, previous: AdminSystemJobs | null) => {
      if (!enabled) return null;
      if (previous && previous.nextCursor === null) return null;
      const cursor = index === 0 ? undefined : (previous?.nextCursor ?? undefined);
      return buildAdminSystemJobsKey({ cursor, limit }, enabled);
    },
    ([, input]: readonly [string, { cursor?: string; limit: number }]) => service.getJobs(input),
    { revalidateFirstPage: false, revalidateOnFocus: false },
  );
  const pages = swr.data ?? [];
  const jobs = collectAdminSystemJobs(pages);
  const visibleHasActiveJobs = hasActiveAdminSystemJobs(jobs);
  const authoritativeActiveCount = options.authoritativeActiveCount;
  const shouldPoll =
    enabled && shouldPollAdminSystemJobs({ authoritativeActiveCount, visibleHasActiveJobs });
  const poll = useClientDataSWR(
    buildAdminSystemJobsPollKey(shouldPoll, limit),
    () => service.getJobs({ limit }),
    {
      refreshInterval: shouldPoll ? ACTIVE_JOB_POLL_INTERVAL_MS : 0,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      onSuccess: (incoming) => {
        setStagedFirstPage(adminSystemJobsChanged(pages[0], incoming) ? incoming : null);
        // The first page may contain only newer terminal jobs. The aggregate is the authority for
        // stopping polling, so refresh it every cycle instead of inferring zero from this page.
        void options.refreshAuthority().catch((error: unknown) => {
          console.error('[admin.system] failed to refresh active-job authority', error);
        });
      },
    },
  );

  const loadedPages = swr.data?.length ?? 0;
  const settled = swr.data !== undefined;
  const reachedEnd = loadedPages > 0 && pages.at(-1)?.nextCursor === null;
  const applyStagedUpdate = useCallback(async () => {
    if (!stagedFirstPage) return;
    const incoming = stagedFirstPage;
    await swr.mutate(() => resetAdminSystemJobPages(incoming), {
      revalidate: false,
    });
    setStagedFirstPage(null);
  }, [stagedFirstPage, swr.mutate]);

  const errorPhase = classifyAdminSystemJobsError({
    error: swr.error,
    loadedPages,
    requestedPages: swr.size,
    settled,
  });
  const refresh = useCallback(async () => {
    setStagedFirstPage(null);
    const result = await swr.mutate();
    void options.refreshAuthority().catch((error: unknown) => {
      console.error('[admin.system] failed to refresh active-job authority', error);
    });
    return result;
  }, [options.refreshAuthority, swr.mutate]);

  return {
    applyStagedUpdate,
    backgroundError: errorPhase === 'background' ? swr.error : undefined,
    hasActiveJobs:
      authoritativeActiveCount === 0
        ? false
        : (authoritativeActiveCount ?? 0) > 0 || visibleHasActiveJobs,
    hasMore: enabled && loadedPages > 0 && !reachedEnd,
    hasStagedUpdate: stagedFirstPage !== null,
    isLoadingInitial: enabled && !settled && swr.isValidating,
    isLoadingMore: swr.isValidating && loadedPages > 0 && swr.size > loadedPages,
    initialError: errorPhase === 'initial' ? swr.error : undefined,
    jobs,
    loadMore: () => void swr.setSize((size) => size + 1),
    loadMoreError: errorPhase === 'load_more' && !swr.isValidating,
    pollError: poll.error,
    refresh,
    retryLoadMore: () => void swr.setSize(swr.size),
  };
};

export interface AdminSystemJobMutations {
  busyJobIds: readonly string[];
  cancel: (job: AdminSystemJob, reason: string) => Promise<AdminSystemJobMutationResult>;
  refreshPendingJobIds: readonly string[];
  retry: (job: AdminSystemJob, reason: string) => Promise<AdminSystemJobMutationResult>;
  retryRefresh: () => Promise<boolean>;
}

export type AdminSystemJobMutationResult = 'conflict' | 'failed' | 'refresh_failed' | 'succeeded';

interface UseAdminSystemJobMutationsOptions {
  authMethod: AdminReauthAuthMethod;
  onRefresh: () => Promise<AdminSystemJobs[] | undefined>;
  service: AdminSystemService;
}

export const useAdminSystemJobMutations = ({
  authMethod,
  onRefresh,
  service,
}: UseAdminSystemJobMutationsOptions): AdminSystemJobMutations => {
  const busyRef = useRef(new Set<string>());
  const refreshPendingRef = useRef(new Map<string, AdminSystemJob>());
  const [busyJobIds, setBusyJobIds] = useState<readonly string[]>([]);
  const [refreshPendingJobIds, setRefreshPendingJobIds] = useState<readonly string[]>([]);

  const retryRefresh = useCallback(async () => {
    try {
      const pages = await onRefresh();
      for (const [jobId, committed] of refreshPendingRef.current) {
        if (didAdminSystemJobRefreshConfirm(pages, committed)) {
          refreshPendingRef.current.delete(jobId);
        }
      }
      setRefreshPendingJobIds([...refreshPendingRef.current.keys()]);
      return refreshPendingRef.current.size === 0;
    } catch (error) {
      console.error('[admin.system] failed to refresh committed job state', error);
      return false;
    }
  }, [onRefresh]);

  const run = useCallback(
    async (job: AdminSystemJob, reason: string, action: AdminSystemJobAction) => {
      if (
        busyRef.current.has(job.jobId) ||
        refreshPendingRef.current.has(job.jobId) ||
        !canRunAdminSystemJobAction(job, action)
      ) {
        return 'failed' as const;
      }
      const expectedRevision = job.revision;
      if (expectedRevision === null) return 'failed' as const;
      busyRef.current.add(job.jobId);
      setBusyJobIds([...busyRef.current]);
      const requestId = crypto.randomUUID();
      try {
        let committed: AdminSystemJob;
        try {
          committed = await withAdminReauthRetry(
            () => {
              const base = {
                expectedRevision,
                jobId: job.jobId,
                reason,
                requestId,
              };
              if (action === 'cancel') {
                if (job.status !== 'pending' && job.status !== 'running') {
                  return Promise.reject(new Error('PLATFORM_INVALID_JOB_TRANSITION'));
                }
                return service.cancelJob({ ...base, expectedStatus: job.status });
              }
              if (job.status !== 'cancelled' && job.status !== 'dead' && job.status !== 'failed') {
                return Promise.reject(new Error('PLATFORM_INVALID_JOB_TRANSITION'));
              }
              return service.retryJob({ ...base, expectedStatus: job.status });
            },
            { authMethod },
          );
        } catch (error) {
          if (isAdminSystemConflictError(error)) {
            await onRefresh().catch((refreshError: unknown) => {
              console.error('[admin.system] failed to refresh after a job conflict', refreshError);
            });
            return 'conflict' as const;
          }
          console.error('[admin.system] job mutation failed', error);
          return 'failed' as const;
        }

        // Mutation response is the authoritative CAS result (by-id confirmation).
        // List refresh is best-effort for UI; pagination drift must not lock the row.
        if (!isAdminSystemJobMutationAuthoritative(committed)) {
          refreshPendingRef.current.set(job.jobId, committed);
          setRefreshPendingJobIds([...refreshPendingRef.current.keys()]);
          return 'refresh_failed' as const;
        }
        try {
          const pages = await onRefresh();
          if (!didAdminSystemJobRefreshConfirm(pages, committed)) {
            // Stale row still visible on a loaded page with different CAS — keep pending.
            throw new Error('PLATFORM_COMMITTED_JOB_REFRESH_UNCONFIRMED');
          }
          return 'succeeded' as const;
        } catch (error) {
          // Network / hard refresh failure: retain pending so the operator can retry.
          // Pagination omission is not a failure (handled in didAdminSystemJobRefreshConfirm).
          if (
            error instanceof Error &&
            error.message === 'PLATFORM_COMMITTED_JOB_REFRESH_UNCONFIRMED'
          ) {
            refreshPendingRef.current.set(job.jobId, committed);
            setRefreshPendingJobIds([...refreshPendingRef.current.keys()]);
            console.error('[admin.system] job mutation committed but refresh failed', error);
            return 'refresh_failed' as const;
          }
          // Refresh threw (network): still treat mutation as committed; flag for retry UI.
          refreshPendingRef.current.set(job.jobId, committed);
          setRefreshPendingJobIds([...refreshPendingRef.current.keys()]);
          console.error('[admin.system] job mutation committed but refresh failed', error);
          return 'refresh_failed' as const;
        }
      } finally {
        busyRef.current.delete(job.jobId);
        setBusyJobIds([...busyRef.current]);
      }
    },
    [authMethod, onRefresh, service],
  );

  return {
    busyJobIds,
    cancel: (job, reason) => run(job, reason, 'cancel'),
    refreshPendingJobIds,
    retryRefresh,
    retry: (job, reason) => run(job, reason, 'retry'),
  };
};
