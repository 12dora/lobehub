import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';

import { getEnterpriseErrorBody } from './enterpriseErrors';
import { assertDangerousReauthWithAudit, assertRecentReauth } from './reauth';

const { appendMock } = vi.hoisted(() => ({
  appendMock: vi.fn(),
}));

vi.mock('../services/platformAudit', () => ({
  PlatformAuditService: class PlatformAuditService {
    append = (...args: unknown[]) => appendMock(...args);
  },
}));

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
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth',
      });
      expect.fail('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
    }
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
        action: 'admin.branding.publish',
        actorUserId: 'user-1',
        authenticatedAt: new Date(),
        authMethod: 'better-auth',
        reason: 'rotate logo',
        requestId: 'req-1',
        serverDB,
        targetId: 'global',
        targetType: 'branding',
      }),
    ).resolves.toBeUndefined();

    expect(appendMock).not.toHaveBeenCalled();
  });

  it('appends denied audit with per-site target/action/requestId then rethrows', async () => {
    await expect(
      assertDangerousReauthWithAudit({
        action: 'admin.system.jobs.cancel',
        actorUserId: 'user-1',
        authenticatedAt: null,
        authMethod: 'better-auth',
        reason: 'cancel stuck job',
        requestId: 'req-cancel-1',
        serverDB,
        targetId: 'job-42',
        targetType: 'platform_job',
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
        action: 'admin.aiCatalog.publish',
        actorUserId: 'user-1',
        authenticatedAt: new Date(),
        authMethod: 'better-auth',
        reason: 'ignored-when-fresh',
        resolveDeniedReason,
        serverDB,
        targetId: 'provider-1',
        targetType: 'provider',
      }),
    ).resolves.toBeUndefined();
    expect(resolveDeniedReason).not.toHaveBeenCalled();

    await expect(
      assertDangerousReauthWithAudit({
        action: 'admin.aiCatalog.publish',
        actorUserId: 'user-1',
        authenticatedAt: null,
        authMethod: 'better-auth',
        reason: 'ignored-when-resolver-present',
        resolveDeniedReason,
        serverDB,
        targetId: 'provider-1',
        targetType: 'provider',
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

  it('swallows audit failures and still rethrows the reauth error', async () => {
    appendMock.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      assertDangerousReauthWithAudit({
        action: 'admin.settings.publish',
        actorUserId: 'user-1',
        auditFailureLog: '[admin.settings] reauth denied audit unavailable',
        authenticatedAt: null,
        authMethod: 'oidc',
        reason: 'publish settings',
        serverDB,
        targetId: 'global',
        targetType: 'settings',
      }),
    ).rejects.toSatisfy((error) => {
      expect(getEnterpriseErrorBody(error)?.code).toBe(ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED);
      return true;
    });

    expect(errorSpy).toHaveBeenCalledWith(
      '[admin.settings] reauth denied audit unavailable',
      expect.objectContaining({
        action: 'admin.settings.publish',
        errorClass: 'Error',
      }),
    );
  });

  it('can silence audit-failure logs (legacy branding path)', async () => {
    appendMock.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      assertDangerousReauthWithAudit({
        action: 'admin.branding.publish',
        actorUserId: 'user-1',
        auditFailureLog: false,
        authenticatedAt: null,
        authMethod: 'better-auth',
        reason: 'publish branding',
        requestId: 'req-branding',
        serverDB,
        targetId: 'global',
        targetType: 'branding',
      }),
    ).rejects.toBeTruthy();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('supports errorClass-only metadata when auditFailureMeta is empty', async () => {
    appendMock.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      assertDangerousReauthWithAudit({
        action: 'admin.system.jobs.cancel',
        actorUserId: 'user-1',
        auditFailureLog: '[admin.system] job reauth denied audit unavailable',
        auditFailureMeta: {},
        authenticatedAt: null,
        authMethod: 'better-auth',
        reason: 'cancel job',
        serverDB,
        targetId: 'job-1',
        targetType: 'platform_job',
      }),
    ).rejects.toBeTruthy();

    expect(errorSpy).toHaveBeenCalledWith(
      '[admin.system] job reauth denied audit unavailable',
      expect.objectContaining({ errorClass: 'Error' }),
    );
    expect(errorSpy.mock.calls[0]?.[1]).not.toHaveProperty('action');
  });
});
