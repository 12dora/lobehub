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

/**
 * Confirm a committed job mutation against a refresh snapshot.
 *
 * The mutation response is the authoritative CAS result. List pages are a
 * best-effort UI projection: when pagination shifts the row off currently
 * loaded pages, treat the committed DTO itself as confirmed rather than
 * leaving the row permanently "refresh pending".
 */
export const didAdminSystemJobRefreshConfirm = (
  pages: readonly AdminSystemJobs[] | undefined,
  committed: AdminSystemJob,
): boolean => {
  if (committed.revision === null) return false;
  const refreshed =
    pages && collectAdminSystemJobs(pages).find((job) => job.jobId === committed.jobId);
  if (refreshed === undefined) {
    // Job not on loaded pages (pagination drift) — mutation response stands.
    return true;
  }
  return refreshed.revision === committed.revision && refreshed.status === committed.status;
};

/** True when the committed mutation DTO itself is a usable CAS snapshot. */
export const isAdminSystemJobMutationAuthoritative = (committed: AdminSystemJob): boolean =>
  committed.revision !== null && typeof committed.jobId === 'string' && committed.jobId.length > 0;

export const isAdminSystemConflictError = (error: unknown): boolean =>
  mapEnterpriseError(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT;

/**
 * Server maps target-revision cursor drift to PLATFORM_INVALID_INPUT.
 * Load-more retry must restart from page one rather than re-send the stale cursor.
 */
export const isAdminSystemInvalidInputError = (error: unknown): boolean =>
  mapEnterpriseError(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
