import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import {
  acceptIdentityProviderRestart,
  AUTHENTIK_ISSUER_PLACEHOLDER,
  createIdentityProviderDraftFromTemplate,
  IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
  IdentityProviderTestPopupBlockedError,
  isIdentityProviderSetupGuidanceError,
  isIdentityProviderTestTerminal,
  openIdentityProviderTestPopup,
  parseIdentityProviderJsonObject,
  resolveIdentityProviderRestartPhase,
  resolveIdentityProviderRevisionRefresh,
  toIdentityProviderStatusBadge,
} from './controller';

describe('identity provider editor controller', () => {
  it('stops polling only for terminal test states', () => {
    expect(isIdentityProviderTestTerminal('pending')).toBe(false);
    expect(isIdentityProviderTestTerminal('processing')).toBe(false);
    expect(isIdentityProviderTestTerminal('succeeded')).toBe(true);
    expect(isIdentityProviderTestTerminal('failed')).toBe(true);
  });

  it('classifies deploy-time feature/config gaps as setup guidance', () => {
    expect(
      isIdentityProviderSetupGuidanceError({
        data: {
          errorData: { code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED },
        },
      }),
    ).toBe(true);
    expect(
      isIdentityProviderSetupGuidanceError({
        data: {
          errorData: { code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED },
        },
      }),
    ).toBe(true);
    expect(
      isIdentityProviderSetupGuidanceError({
        message: 'PLATFORM_APP_URL_INVALID',
      }),
    ).toBe(true);
    expect(
      isIdentityProviderSetupGuidanceError({
        data: {
          errorData: {
            code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
            message: 'PLATFORM_APP_URL_INVALID',
          },
        },
        message: 'PLATFORM_APP_URL_INVALID',
      }),
    ).toBe(true);
    // Generic validation / network failures must keep the normal retry + create path.
    expect(
      isIdentityProviderSetupGuidanceError({
        data: {
          errorData: { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT },
        },
      }),
    ).toBe(false);
    expect(isIdentityProviderSetupGuidanceError(new Error('network failed'))).toBe(false);
    expect(isIdentityProviderSetupGuidanceError(null)).toBe(false);
  });

  it('maps provider lifecycle statuses onto StatusBadge semantics', () => {
    expect(toIdentityProviderStatusBadge('draft')).toBe('draft');
    expect(toIdentityProviderStatusBadge('published')).toBe('published');
    expect(toIdentityProviderStatusBadge('pending_restart')).toBe('pending');
    expect(toIdentityProviderStatusBadge('active')).toBe('active');
    expect(toIdentityProviderStatusBadge('error')).toBe('error');
    expect(toIdentityProviderStatusBadge('disabled')).toBe('disabled');
    expect(toIdentityProviderStatusBadge('archived')).toBe('archived');
    expect(toIdentityProviderStatusBadge('weird')).toBe('unknown');
  });

  it('seeds create drafts from Authentik and generic OIDC templates', () => {
    const authentik = createIdentityProviderDraftFromTemplate('authentik');
    expect(authentik.type).toBe('authentik');
    expect(authentik.scopes).toContain('dingtalk');
    expect(authentik.claimMapping.dingtalkUserId).toEqual(['dingtalk_user_id']);
    expect(authentik.buttonLabel).toBe('使用工作账号登录');

    const generic = createIdentityProviderDraftFromTemplate('generic_oidc');
    expect(generic.type).toBe('generic_oidc');
    expect(generic.scopes).not.toContain('dingtalk');
    expect(AUTHENTIK_ISSUER_PLACEHOLDER).toContain('auth.jiefakj.com');
  });

  it('keeps invalid intermediate JSON outside the canonical draft', () => {
    expect(parseIdentityProviderJsonObject('{"group":')).toEqual({ valid: false });
    expect(parseIdentityProviderJsonObject('[]')).toEqual({ valid: false });
    expect(parseIdentityProviderJsonObject('{"group":"admin"}')).toEqual({
      valid: true,
      value: { group: 'admin' },
    });
  });

  it('opens a blank popup synchronously before awaiting the test-start request', async () => {
    const popup = { closed: false, close: vi.fn(), location: { assign: vi.fn() } };
    let resolveStart!: (value: { authorizationUrl: string }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ authorizationUrl: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const openWindow = vi.fn(() => popup as unknown as Window);

    const pending = openIdentityProviderTestPopup(start, openWindow as typeof window.open);
    expect(openWindow).toHaveBeenCalledWith(
      'about:blank',
      'oidc-provider-test',
      'width=520,height=720',
    );
    expect(start).toHaveBeenCalledOnce();
    expect(popup.location.assign).not.toHaveBeenCalled();

    resolveStart({ authorizationUrl: 'https://login.example.test/authorize' });
    await expect(pending).resolves.toEqual({
      authorizationUrl: 'https://login.example.test/authorize',
    });
    expect(popup.location.assign).toHaveBeenCalledWith('https://login.example.test/authorize');
  });

  it('reports a blocked popup and closes a blank popup when test-start fails', async () => {
    await expect(
      openIdentityProviderTestPopup(
        async () => ({ authorizationUrl: 'https://example.test' }),
        () => null,
      ),
    ).rejects.toBeInstanceOf(IdentityProviderTestPopupBlockedError);

    const popup = { closed: false, close: vi.fn(), location: { assign: vi.fn() } };
    await expect(
      openIdentityProviderTestPopup(
        async () => {
          throw new Error('network failed');
        },
        () => popup as unknown as Window,
      ),
    ).rejects.toThrow('network failed');
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it('stops restart polling on activation, failure, and unsupported convergence', () => {
    const acceptedAt = 1_000;
    const receivedAtMonotonic = 50;
    const attempt = acceptIdentityProviderRestart(
      { expectedIdentityRevision: 'a'.repeat(64), requestId: 'request-1' },
      {
        accepted: true,
        acceptedAt: new Date(acceptedAt),
        convergenceDeadlineAt: new Date(acceptedAt + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS),
        expectedIdentityRevision: 'a'.repeat(64),
        remainingMs: IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
        requestId: 'request-1',
        serverNow: new Date(acceptedAt),
      },
      receivedAtMonotonic,
    )!;
    const pending = {
      active: { allFreshInstancesActive: false },
      pendingRestart: true,
      restart: { supported: true },
      targetIdentityRevision: 'a'.repeat(64),
    };
    expect(
      resolveIdentityProviderRestartPhase({
        attempt,
        error: null,
        nowMonotonic: receivedAtMonotonic,
        phase: 'accepted',
        status: pending,
      }),
    ).toBe('accepted');
    expect(
      resolveIdentityProviderRestartPhase({
        error: null,
        attempt,
        nowMonotonic: receivedAtMonotonic,
        phase: 'accepted',
        status: {
          ...pending,
          active: { allFreshInstancesActive: true },
          pendingRestart: false,
        },
      }),
    ).toBe('activated');
    expect(
      resolveIdentityProviderRestartPhase({
        attempt,
        error: new Error('offline'),
        nowMonotonic: receivedAtMonotonic,
        phase: 'accepted',
      }),
    ).toBe('accepted');
    expect(
      resolveIdentityProviderRestartPhase({
        attempt,
        error: new Error('background refresh failed'),
        nowMonotonic: receivedAtMonotonic,
        phase: 'accepted',
        status: pending,
      }),
    ).toBe('accepted');
    expect(
      resolveIdentityProviderRestartPhase({
        attempt,
        error: null,
        nowMonotonic: receivedAtMonotonic,
        phase: 'accepted',
        status: { ...pending, restart: { supported: false } },
      }),
    ).toBe('failed');
    expect(
      resolveIdentityProviderRestartPhase({
        attempt,
        error: null,
        nowMonotonic: receivedAtMonotonic + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
        phase: 'accepted',
        status: pending,
      }),
    ).toBe('failed');
  });

  it('accepts restart polling only for matching server evidence', () => {
    const prepared = { expectedIdentityRevision: 'a'.repeat(64), requestId: 'request-1' };
    const accepted = {
      accepted: true,
      acceptedAt: new Date(1_000),
      convergenceDeadlineAt: new Date(1_000 + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS),
      expectedIdentityRevision: prepared.expectedIdentityRevision,
      remainingMs: IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
      requestId: prepared.requestId,
      serverNow: new Date(1_000),
    };
    expect(acceptIdentityProviderRestart(prepared, accepted, 50)).toEqual({
      acceptedAt: 1_000,
      convergenceDeadlineAt: 1_000 + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
      deadlineAtMonotonic: 50 + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
      requestId: prepared.requestId,
      targetIdentityRevision: prepared.expectedIdentityRevision,
    });
    expect(
      acceptIdentityProviderRestart(prepared, { ...accepted, requestId: 'different-request' }, 50),
    ).toBeNull();
    expect(
      acceptIdentityProviderRestart(
        prepared,
        {
          ...accepted,
          expectedIdentityRevision: 'b'.repeat(64),
        },
        50,
      ),
    ).toBeNull();
  });

  it('uses the server remaining window as a relative monotonic deadline', () => {
    const prepared = { expectedIdentityRevision: 'a'.repeat(64), requestId: 'request-1' };
    const acceptedAt = new Date('2026-07-19T00:00:00Z');
    const serverNow = new Date(acceptedAt.getTime() + 30_000);
    const attempt = acceptIdentityProviderRestart(
      prepared,
      {
        accepted: true,
        acceptedAt,
        convergenceDeadlineAt: new Date(
          acceptedAt.getTime() + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
        ),
        expectedIdentityRevision: prepared.expectedIdentityRevision,
        remainingMs: 90_000,
        requestId: prepared.requestId,
        serverNow,
      },
      750,
    );

    expect(attempt?.deadlineAtMonotonic).toBe(90_750);
    expect(
      resolveIdentityProviderRestartPhase({
        attempt,
        error: null,
        nowMonotonic: 90_750,
        phase: 'accepted',
      }),
    ).toBe('failed');
  });

  it('preserves a local draft for the conflict refresh and hydrates later revisions', () => {
    expect(
      resolveIdentityProviderRevisionRefresh({
        currentRevision: 3,
        nextRevision: 4,
        preserveDraft: true,
      }),
    ).toBe('preserve');
    expect(
      resolveIdentityProviderRevisionRefresh({
        currentRevision: 4,
        nextRevision: 5,
        preserveDraft: false,
      }),
    ).toBe('hydrate');
    expect(
      resolveIdentityProviderRevisionRefresh({
        currentRevision: 5,
        nextRevision: 5,
        preserveDraft: false,
      }),
    ).toBe('unchanged');
  });
});
