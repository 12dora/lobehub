import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminSystemJob, AdminSystemJobs } from '@/enterprise/client/services/adminSystem';

import {
  adminSystemJobsChanged,
  canRunAdminSystemJobAction,
  classifyAdminSystemJobsError,
  collectAdminSystemJobs,
  deriveAdminSystemPermissions,
  didAdminSystemJobRefreshConfirm,
  resetAdminSystemJobPages,
  shouldPollAdminSystemJobs,
} from './controller';

const job = (overrides: Partial<AdminSystemJob> = {}): AdminSystemJob => ({
  attempt: 1,
  canCancel: true,
  canRetry: false,
  createdAt: new Date('2026-07-20T00:00:00.000Z'),
  errorCategory: null,
  failedCount: 0,
  finishedAt: null,
  jobId: 'pjob_0000000000000001',
  kind: 'agent_rollout',
  maxAttempts: 3,
  progress: { done: 1, total: 3 },
  revision: 1,
  startedAt: new Date('2026-07-20T00:00:01.000Z'),
  status: 'running',
  updatedAt: new Date('2026-07-20T00:00:02.000Z'),
  ...overrides,
});

const page = (items: AdminSystemJob[], nextCursor: string | null = null): AdminSystemJobs => ({
  items,
  nextCursor,
});

describe('Admin System permissions', () => {
  it('derives read and operate independently', () => {
    expect(deriveAdminSystemPermissions([])).toEqual({ canOperate: false, canRead: false });
    expect(deriveAdminSystemPermissions([PLATFORM_PERMISSIONS.SYSTEM_READ])).toEqual({
      canOperate: false,
      canRead: true,
    });
    expect(
      deriveAdminSystemPermissions([
        PLATFORM_PERMISSIONS.SYSTEM_READ,
        PLATFORM_PERMISSIONS.SYSTEM_OPERATE,
      ]),
    ).toEqual({ canOperate: true, canRead: true });
  });
});

describe('Admin System job polling and errors', () => {
  it('uses the aggregate active count as the polling authority', () => {
    expect(
      shouldPollAdminSystemJobs({ authoritativeActiveCount: 2, visibleHasActiveJobs: false }),
    ).toBe(true);
    expect(
      shouldPollAdminSystemJobs({ authoritativeActiveCount: 0, visibleHasActiveJobs: true }),
    ).toBe(false);
    expect(
      shouldPollAdminSystemJobs({ authoritativeActiveCount: null, visibleHasActiveJobs: true }),
    ).toBe(true);
    expect(
      shouldPollAdminSystemJobs({
        authoritativeActiveCount: undefined,
        visibleHasActiveJobs: false,
      }),
    ).toBe(false);
  });

  it('separates initial, load-more, and background failures', () => {
    const error = new Error('offline');
    expect(
      classifyAdminSystemJobsError({ error, loadedPages: 0, requestedPages: 1, settled: false }),
    ).toBe('initial');
    expect(
      classifyAdminSystemJobsError({ error, loadedPages: 1, requestedPages: 2, settled: true }),
    ).toBe('load_more');
    expect(
      classifyAdminSystemJobsError({ error, loadedPages: 1, requestedPages: 1, settled: true }),
    ).toBe('background');
    expect(
      classifyAdminSystemJobsError({
        error: undefined,
        loadedPages: 1,
        requestedPages: 2,
        settled: true,
      }),
    ).toBeNull();
  });
});

describe('Admin System job collection', () => {
  it('stages progress and order changes instead of treating them as equal', () => {
    const first = page([job()]);
    expect(adminSystemJobsChanged(first, page([job({ progress: { done: 2, total: 3 } })]))).toBe(
      true,
    );
    expect(
      adminSystemJobsChanged(
        page([job(), job({ jobId: 'pjob_0000000000000002' })]),
        page([job({ jobId: 'pjob_0000000000000002' }), job()]),
      ),
    ).toBe(true);
    expect(adminSystemJobsChanged(first, page([job()]))).toBe(false);
  });

  it('resets stale cursor pages when applying a staged first page', () => {
    const repeated = job({ jobId: 'pjob_0000000000000002' });
    const merged = resetAdminSystemJobPages(page([repeated], 'next'));

    expect(collectAdminSystemJobs(merged).map(({ jobId }) => jobId)).toEqual([
      'pjob_0000000000000002',
    ]);
    expect(merged).toHaveLength(1);
  });

  it('requires the refreshed row to match the committed revision and status', () => {
    const committed = job({ revision: 2, status: 'cancelled' });
    expect(didAdminSystemJobRefreshConfirm([page([committed])], committed)).toBe(true);
    expect(didAdminSystemJobRefreshConfirm([page([job()])], committed)).toBe(false);
    expect(didAdminSystemJobRefreshConfirm([], committed)).toBe(false);
  });
});

describe('Admin System job actions', () => {
  it('requires server capability, revision, and an eligible status', () => {
    expect(canRunAdminSystemJobAction(job(), 'cancel')).toBe(true);
    expect(canRunAdminSystemJobAction(job({ revision: null }), 'cancel')).toBe(false);
    expect(canRunAdminSystemJobAction(job({ canCancel: false }), 'cancel')).toBe(false);
    expect(canRunAdminSystemJobAction(job({ status: 'reserved' }), 'cancel')).toBe(false);
    expect(
      canRunAdminSystemJobAction(
        job({ canCancel: false, canRetry: true, status: 'failed' }),
        'retry',
      ),
    ).toBe(true);
  });
});
