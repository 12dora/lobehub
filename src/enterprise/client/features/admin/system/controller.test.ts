import { describe, expect, it } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminSystemJob, AdminSystemJobs } from '@/enterprise/client/services/adminSystem';

import {
  adminSystemJobsChanged,
  canRunAdminSystemJobAction,
  classifyAdminSystemJobsError,
  collectAdminSystemJobs,
  deriveAdminSystemPermissions,
  deriveSsoPresentation,
  didAdminSystemJobRefreshConfirm,
  isAdminSystemInvalidInputError,
  resetAdminSystemJobPages,
  shouldPollAdminSystemJobs,
  type SsoOidcStatus,
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
  typeId: 'platform.agent.rollout.v1',
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

  it('detects PLATFORM_INVALID_INPUT for target-bound cursor invalidation', () => {
    expect(
      isAdminSystemInvalidInputError({
        data: { errorData: { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT } },
      }),
    ).toBe(true);
    expect(isAdminSystemInvalidInputError(new Error('network blip'))).toBe(false);
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

  it('requires the refreshed row to match the committed revision and status when present', () => {
    const committed = job({ revision: 2, status: 'cancelled' });
    expect(didAdminSystemJobRefreshConfirm([page([committed])], committed)).toBe(true);
    expect(didAdminSystemJobRefreshConfirm([page([job()])], committed)).toBe(false);
  });

  it('treats mutation as confirmed when pagination omits the committed job', () => {
    const committed = job({ revision: 2, status: 'cancelled' });
    // Empty / other-page load: job pushed off page one after cancel — still confirmed.
    expect(didAdminSystemJobRefreshConfirm([], committed)).toBe(true);
    expect(
      didAdminSystemJobRefreshConfirm(
        [page([job({ jobId: 'pjob_0000000000000099', revision: 1 })])],
        committed,
      ),
    ).toBe(true);
  });
});

const oidc = (overrides: Partial<SsoOidcStatus> = {}): SsoOidcStatus => ({
  activeRevision: 'a'.repeat(64),
  configured: true,
  pendingRestart: false,
  source: 'database',
  status: 'healthy',
  ...overrides,
});

describe('deriveSsoPresentation', () => {
  it('treats disabled flag, disabled source, and missing config as not configured', () => {
    expect(
      deriveSsoPresentation({ oidc: oidc({ source: 'disabled', status: 'disabled' }) }).kind,
    ).toBe('not_configured');
    expect(deriveSsoPresentation({ oidc: oidc({ configured: false }) }).kind).toBe(
      'not_configured',
    );
    expect(
      deriveSsoPresentation({
        oidc: oidc({
          activeRevision: null,
          configured: true,
          pendingRestart: false,
          source: 'unknown',
          status: 'unavailable',
        }),
      }).kind,
    ).toBe('not_configured');
  });

  it('prefers restart pending over unknown source when a publish is waiting', () => {
    const presentation = deriveSsoPresentation({
      oidc: oidc({
        activeRevision: null,
        pendingRestart: true,
        source: 'unknown',
        status: 'healthy',
      }),
    });
    expect(presentation.kind).toBe('restart_pending');
    expect(presentation.labelKey).toBe('system.oidc.pendingRestart');
    expect(presentation.showSource).toBe(false);
  });

  it('prefers restart pending over degraded artifact health', () => {
    expect(
      deriveSsoPresentation({
        oidc: oidc({ pendingRestart: true, status: 'degraded' }),
      }).kind,
    ).toBe('restart_pending');
  });

  it('surfaces unavailable ahead of restart-pending as attention', () => {
    const presentation = deriveSsoPresentation({
      oidc: oidc({
        configured: true,
        pendingRestart: true,
        status: 'unavailable',
      }),
    });
    expect(presentation).toMatchObject({
      kind: 'attention',
      labelKey: 'system.oidc.attention',
      tone: 'error',
    });
  });

  it('reports enabled only when healthy, configured, and not waiting on restart', () => {
    const presentation = deriveSsoPresentation({ oidc: oidc() });
    expect(presentation).toMatchObject({
      kind: 'enabled',
      labelKey: 'system.oidc.enabled',
      showSource: true,
      tone: 'success',
    });
  });

  it('reports attention for degraded or unavailable SSO and surfaces the category', () => {
    const presentation = deriveSsoPresentation({
      oidc: oidc({ status: 'degraded' }),
      snapshot: { artifact: { degradedCategory: 'secret_unavailable' } },
    });
    expect(presentation).toMatchObject({
      degradedCategory: 'secret_unavailable',
      descriptionKey: 'system.oidc.attentionHint',
      kind: 'attention',
      labelKey: 'system.oidc.attention',
      tone: 'warning',
    });
    expect(deriveSsoPresentation({ oidc: oidc({ status: 'unavailable' }) }).tone).toBe('error');
  });

  it('hides the source line when break-glass has no live SSO providers', () => {
    const presentation = deriveSsoPresentation({
      oidc: oidc({
        configured: false,
        source: 'break_glass',
        status: 'degraded',
      }),
    });
    expect(presentation.kind).toBe('not_configured');
    expect(presentation.showSource).toBe(false);
    expect(presentation.labelKey).toBe('system.oidc.notConfigured');
  });

  it('reports attention for a real break-glass fallback that still has live SSO', () => {
    const presentation = deriveSsoPresentation({
      oidc: oidc({ configured: true, source: 'break_glass', status: 'degraded' }),
      snapshot: { artifact: { degradedCategory: 'break_glass_fallback' } },
    });
    expect(presentation).toMatchObject({
      degradedCategory: 'break_glass_fallback',
      kind: 'attention',
      showSource: true,
      tone: 'warning',
    });
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
