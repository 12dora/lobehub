import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminSystemJob, AdminSystemJobs } from '@/enterprise/client/services/adminSystem';

export interface AdminSystemPermissions {
  canOperate: boolean;
  canRead: boolean;
}

export const deriveAdminSystemPermissions = (
  permissions: readonly string[],
): AdminSystemPermissions => {
  const granted = new Set(permissions);
  return {
    canOperate: granted.has(PLATFORM_PERMISSIONS.SYSTEM_OPERATE),
    canRead: granted.has(PLATFORM_PERMISSIONS.SYSTEM_READ),
  };
};

const ACTIVE_JOB_STATUSES = new Set<AdminSystemJob['status']>(['pending', 'reserved', 'running']);
const CANCELLABLE_JOB_STATUSES = new Set<AdminSystemJob['status']>(['pending', 'running']);
const RETRYABLE_JOB_STATUSES = new Set<AdminSystemJob['status']>(['cancelled', 'dead', 'failed']);

export const isAdminSystemJobActive = (job: AdminSystemJob): boolean =>
  ACTIVE_JOB_STATUSES.has(job.status);

export const hasActiveAdminSystemJobs = (jobs: readonly AdminSystemJob[]): boolean =>
  jobs.some(isAdminSystemJobActive);

export const shouldPollAdminSystemJobs = (input: {
  authoritativeActiveCount?: number | null;
  visibleHasActiveJobs: boolean;
}): boolean => {
  if (input.authoritativeActiveCount === 0) return false;
  if ((input.authoritativeActiveCount ?? 0) > 0) return true;
  return input.visibleHasActiveJobs;
};

export type AdminSystemJobsErrorPhase = 'background' | 'initial' | 'load_more' | null;

export const classifyAdminSystemJobsError = (input: {
  error: unknown;
  loadedPages: number;
  requestedPages: number;
  settled: boolean;
}): AdminSystemJobsErrorPhase => {
  if (!input.error) return null;
  if (!input.settled) return 'initial';
  if (input.requestedPages > input.loadedPages) return 'load_more';
  return 'background';
};

export type AdminSystemJobAction = 'cancel' | 'retry';

export const canRunAdminSystemJobAction = (
  job: AdminSystemJob,
  action: AdminSystemJobAction,
): boolean => {
  if (job.revision === null) return false;
  if (action === 'cancel') return job.canCancel && CANCELLABLE_JOB_STATUSES.has(job.status);
  return job.canRetry && RETRYABLE_JOB_STATUSES.has(job.status);
};

const jobFingerprint = (job: AdminSystemJob): string =>
  [
    job.jobId,
    job.status,
    job.revision ?? 'none',
    job.progress.done,
    job.progress.total ?? 'none',
    job.failedCount ?? 'none',
    job.updatedAt.toISOString(),
  ].join(':');

/** Order-sensitive fingerprint: a reordered first page is staged instead of applied silently. */
export const getAdminSystemJobsFingerprint = (page: AdminSystemJobs | undefined): string =>
  page?.items.map(jobFingerprint).join('|') ?? '';

export const adminSystemJobsChanged = (
  visible: AdminSystemJobs | undefined,
  incoming: AdminSystemJobs | undefined,
): boolean =>
  Boolean(incoming) &&
  getAdminSystemJobsFingerprint(visible) !== getAdminSystemJobsFingerprint(incoming);

/** A new first page invalidates every older keyset cursor in the loaded tail. */
export const resetAdminSystemJobPages = (firstPage: AdminSystemJobs): AdminSystemJobs[] => [
  firstPage,
];

export const collectAdminSystemJobs = (pages: readonly AdminSystemJobs[]): AdminSystemJob[] => {
  const seen = new Set<string>();
  const jobs: AdminSystemJob[] = [];
  for (const page of pages) {
    for (const job of page.items) {
      if (seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      jobs.push(job);
    }
  }
  return jobs;
};

export const didAdminSystemJobRefreshConfirm = (
  pages: readonly AdminSystemJobs[] | undefined,
  committed: AdminSystemJob,
): boolean => {
  const refreshed =
    pages && collectAdminSystemJobs(pages).find((job) => job.jobId === committed.jobId);
  return (
    refreshed !== undefined &&
    refreshed.revision === committed.revision &&
    refreshed.status === committed.status
  );
};

export const isAdminSystemConflictError = (error: unknown): boolean =>
  mapEnterpriseError(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT;
