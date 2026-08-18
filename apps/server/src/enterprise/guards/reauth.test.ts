import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';

import { ADMIN_REAUTH_MAX_AGE_MS } from '../contracts/adminUsers';
import { getEnterpriseErrorBody } from './enterpriseErrors';
import { assertDangerousReauthWithAudit, assertRecentReauth } from './reauth';

const { appendMock } = vi.hoisted(() => ({
  appendMock: vi.fn(),
}));

vi.mock('../services/platformAudit', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    PlatformAuditService: {
      logDeniedAuditAppendFailure: (error: unknown, action: string) => void;
    };
  };
  return {
    PlatformAuditService: class PlatformAuditService {
      // Keep the real centralized log contract (asserted by tests below).
      static logDeniedAuditAppendFailure = actual.PlatformAuditService.logDeniedAuditAppendFailure;
      append = (...args: unknown[]) => appendMock(...args);
    },
  };
});

describe('assertRecentReauth', () => {
  it('allows recent better-auth / oidc / dev-mock', () => {
    expect(() =>
      assertRecentReauth({
        authenticatedAt: new Date(),
        authMethod: 'better-auth',
      }),
    ).not.toThrow();
    expect(() =>
      assertRecentReauth({
        authenticatedAt: new Date(),
        authMethod: 'oidc',
      }),
    ).not.toThrow();
    expect(() =>
      assertRecentReauth({
        authenticatedAt: new Date(),
        authMethod: 'dev-mock',
      }),
    ).not.toThrow();
  });

  it('rejects api-key even with a timestamp', () => {
    try {
      assertRecentReauth({
        authenticatedAt: new Date(),
        authMethod: 'api-key',
      });
      expect.fail('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
    }
  });

  it('rejects missing authenticatedAt', () => {
    try {
      assertRecentReauth({ authMethod: 'better-auth', authenticatedAt: null });
      expect.fail('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
    }
  });

  it('rejects stale authenticatedAt', () => {
    try {
      assertRecentReauth({
        // Derived from the window rather than a literal: the window has been widened
        // once already, and a literal silently stops testing staleness when it is.
        authenticatedAt: new Date(Date.now() - ADMIN_REAUTH_MAX_AGE_MS - 1000),
        authMethod: 'better-auth',
      });
      expect.fail('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
    }
  });

  it('accepts an administrator who has been working for a while', () => {
    // The window exists to bound stale/replayed sessions, not to interrupt a session
    // in progress: `authenticatedAt` is the original login time and is never refreshed,
    // so anything shorter than a working day logs admins out of their own tools mid-task.
    expect(ADMIN_REAUTH_MAX_AGE_MS).toBeGreaterThanOrEqual(4 * 60 * 60 * 1000);
    expect(() =>
      assertRecentReauth({
        authenticatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        authMethod: 'better-auth',
      }),
    ).not.toThrow();
  });
});

describe('assertDangerousReauthWithAudit', () => {
  const serverDB = {} as never;

  beforeEach(() => {
    appendMock.mockReset();
    appendMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through when reauth is fresh', async () => {
    await expect(
      assertDangerousReauthWithAudit({
        authenticatedAt: new Date(),
        authMethod: 'better-auth',
        serverDB,
        denied: {
          action: 'admin.branding.publish',
          actorUserId: 'user-1',
          reason: 'rotate logo',
          requestId: 'req-1',
          targetId: 'global',
          targetType: 'branding',
        },
      }),
    ).resolves.toBeUndefined();

    expect(appendMock).not.toHaveBeenCalled();
  });

  it('appends denied audit with per-site target/action/requestId then rethrows', async () => {
    await expect(
      assertDangerousReauthWithAudit({
        authenticatedAt: null,
        authMethod: 'better-auth',
        serverDB,
        denied: {
          action: 'admin.system.jobs.cancel',
          actorUserId: 'user-1',
          reason: 'cancel stuck job',
          requestId: 'req-cancel-1',
          targetId: 'job-42',
          targetType: 'platform_job',
        },
      }),
    ).rejects.toSatisfy((error) => {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
      return true;
    });

    expect(appendMock).toHaveBeenCalledWith({
      action: 'admin.system.jobs.cancel',
      actorUserId: 'user-1',
      afterDiff: { error: 'reauth_required' },
      reason: 'cancel stuck job',
      requestId: 'req-cancel-1',
      result: 'denied',
      targetId: 'job-42',
      targetType: 'platform_job',
    });
  });

  it('uses resolveDeniedReason only on the denial path', async () => {
    const resolveDeniedReason = vi.fn().mockResolvedValue('safe-reason');

    await expect(
      assertDangerousReauthWithAudit({
        authenticatedAt: new Date(),
        authMethod: 'better-auth',
        serverDB,
        denied: {
          action: 'admin.aiProviders.publish',
          actorUserId: 'user-1',
          reason: 'ignored-when-fresh',
          resolveDeniedReason,
          targetId: 'provider-1',
          targetType: 'provider',
        },
      }),
    ).resolves.toBeUndefined();
    expect(resolveDeniedReason).not.toHaveBeenCalled();

    await expect(
      assertDangerousReauthWithAudit({
        authenticatedAt: null,
        authMethod: 'better-auth',
        serverDB,
        denied: {
          action: 'admin.aiProviders.publish',
          actorUserId: 'user-1',
          reason: 'ignored-when-resolver-present',
          resolveDeniedReason,
          targetId: 'provider-1',
          targetType: 'provider',
        },
      }),
    ).rejects.toBeTruthy();

    expect(resolveDeniedReason).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'safe-reason',
        targetId: 'provider-1',
        targetType: 'provider',
      }),
    );
  });

  it('centralizes audit-failure logging and still rethrows the reauth error', async () => {
    appendMock.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      assertDangerousReauthWithAudit({
        authenticatedAt: null,
        authMethod: 'oidc',
        serverDB,
        denied: {
          action: 'admin.settings.publish',
          actorUserId: 'user-1',
          reason: 'publish settings',
          targetId: 'global',
          targetType: 'settings',
        },
      }),
    ).rejects.toSatisfy((error) => {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
      return true;
    });

    expect(errorSpy).toHaveBeenCalledWith(
      '[admin.reauth] reauth denied audit failed',
      expect.objectContaining({
        action: 'admin.settings.publish',
        errorClass: 'Error',
      }),
    );
  });

  it('never allows callers to silence audit-failure observability', async () => {
    appendMock.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      assertDangerousReauthWithAudit({
        authenticatedAt: null,
        authMethod: 'better-auth',
        serverDB,
        denied: {
          action: 'admin.branding.publish',
          actorUserId: 'user-1',
          reason: 'publish branding',
          requestId: 'req-branding',
          targetId: 'global',
          targetType: 'branding',
        },
      }),
    ).rejects.toBeTruthy();

    expect(errorSpy).toHaveBeenCalledWith(
      '[admin.reauth] reauth denied audit failed',
      expect.objectContaining({
        action: 'admin.branding.publish',
        errorClass: 'Error',
      }),
    );
  });
});
