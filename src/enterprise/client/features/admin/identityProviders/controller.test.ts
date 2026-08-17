import { DINGTALK_IDENTITY_PROVIDER_ISSUER } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import {
  acceptIdentityProviderRestart,
  AUTHENTIK_ISSUER_PLACEHOLDER,
  buildIdentityProviderTestFailureMessage,
  classifyIdentityProviderWorkflowError,
  createIdentityProviderDraftFromTemplate,
  extractIdentityProviderTestErrorCode,
  IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
  identityProviderTestErrorKey,
  IdentityProviderTestPopupBlockedError,
  identityProviderTestRemedyKey,
  isFixedProtocolIdentityProviderType,
  isIdentityProviderDeletable,
  isIdentityProviderDisableable,
  isIdentityProviderDraftWorkflowReady,
  isIdentityProviderSetupGuidanceError,
  isIdentityProviderTestTerminal,
  openIdentityProviderTestPopup,
  parseIdentityProviderJsonObject,
  resolveIdentityProviderRestartPhase,
  resolveIdentityProviderRevisionRefresh,
  resolveIdentityProviderWizardLiveProvider,
  resolvePublishedHistorySignal,
  serializeIdentityProviderAllowedCorps,
  toIdentityProviderStatusBadge,
} from './controller';
import {
  canPersistIdentityProviderDraft,
  createIdentityProviderPersistGate,
  formatIdentityProviderAutoSavedAt,
  resolveIdentityProviderSecretMutation,
  resolveIdentityProviderWizardClose,
  shouldSkipIdentityProviderPersist,
  toWritableIdentityProviderFields,
} from './persist';
import {
  getIdentityProviderStatusPresentation,
  isIdentityProviderConfigured,
} from './statusPresentation';

describe('identity provider editor controller', () => {
  it('allows the test and publish workflow only for server-side drafts', () => {
    expect(isIdentityProviderDraftWorkflowReady({ status: 'draft' })).toBe(true);
    for (const status of ['active', 'pending_restart', 'published', 'error'] as const) {
      expect(isIdentityProviderDraftWorkflowReady({ status })).toBe(false);
    }
    expect(isIdentityProviderDraftWorkflowReady(undefined)).toBe(false);
  });

  it('maps structured workflow preconditions to actionable editor errors', () => {
    const error = (reason: string) => ({
      data: {
        errorData: {
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          details: { reason },
        },
      },
    });

    expect(classifyIdentityProviderWorkflowError(error('identity_provider_draft_required'))).toBe(
      'draft-required',
    );
    expect(classifyIdentityProviderWorkflowError(error('identity_provider_test_required'))).toBe(
      'test-required',
    );
    expect(classifyIdentityProviderWorkflowError(new Error('network failed'))).toBe('generic');
  });

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

  it('treats unpublished rows as pending configuration and describes completeness', () => {
    const incomplete = getIdentityProviderStatusPresentation({ status: 'draft' });
    expect(incomplete.kind).toBe('pendingConfiguration');
    expect(incomplete.configured).toBe(false);
    expect(incomplete.descriptionKey).toBe(
      'identityProviders.status.pendingConfiguration.incomplete',
    );
    const configured = getIdentityProviderStatusPresentation({
      clientId: 'app',
      displayName: 'Work',
      issuer: 'https://login.example.test',
      providerKey: 'work',
      secret: { configured: true },
      status: 'draft',
      type: 'generic_oidc',
    });
    expect(configured.kind).toBe('pendingConfiguration');
    expect(configured.configured).toBe(true);
    expect(configured.descriptionKey).toBe(
      'identityProviders.status.pendingConfiguration.configured',
    );
    expect(getIdentityProviderStatusPresentation({ status: undefined }).kind).toBe(
      'pendingConfiguration',
    );
    expect(getIdentityProviderStatusPresentation({ status: 'pending_restart' }).labelKey).toBe(
      'identityProviders.status.restartPending',
    );
    expect(getIdentityProviderStatusPresentation({ status: 'published' }).kind).toBe(
      'restartPending',
    );
    expect(getIdentityProviderStatusPresentation({ status: 'active' }).kind).toBe('enabled');
    expect(getIdentityProviderStatusPresentation({ status: 'disabled' }).kind).toBe('disabled');
    expect(getIdentityProviderStatusPresentation({ status: 'archived' }).kind).toBe('disabled');
    expect(getIdentityProviderStatusPresentation({ status: 'error' }).kind).toBe('error');
  });

  it('requires display name, key, issuer, client, secret, and DingTalk allowlist to be configured', () => {
    const complete = {
      clientId: 'app',
      dingtalkAllowedCorps: [{ corpId: 'ding1' }],
      displayName: 'Work',
      issuer: 'https://login.example.test',
      providerKey: 'work',
      secret: { configured: true },
      type: 'generic_oidc',
    };
    expect(isIdentityProviderConfigured(complete)).toBe(true);
    expect(isIdentityProviderConfigured({ ...complete, issuer: null })).toBe(false);
    expect(isIdentityProviderConfigured({ ...complete, clientId: '' })).toBe(false);
    expect(isIdentityProviderConfigured({ ...complete, secret: { configured: false } })).toBe(
      false,
    );
    expect(
      isIdentityProviderConfigured({
        ...complete,
        dingtalkAllowedCorps: [],
        type: 'dingtalk',
      }),
    ).toBe(false);
    expect(
      isIdentityProviderConfigured({
        ...complete,
        type: 'dingtalk',
      }),
    ).toBe(true);
  });

  it('treats missing published-history as unknown (never no-history)', () => {
    expect(resolvePublishedHistorySignal({}, 'idp-1')).toBe('unknown');
    expect(resolvePublishedHistorySignal({ 'idp-1': 'has-history' }, 'idp-1')).toBe('has-history');
    expect(resolvePublishedHistorySignal({ 'idp-1': 'no-history' }, 'idp-1')).toBe('no-history');
  });

  it('fail-safes Disable on unknown history and withholds Delete until confirmed empty', () => {
    const draft = { status: 'draft' };
    // publish → edit/clear leaves head as draft; prior revision may still be live.
    expect(isIdentityProviderDisableable(draft, 'has-history')).toBe(true);
    expect(isIdentityProviderDeletable(draft, 'has-history')).toBe(false);

    // Never-published draft: Delete only.
    expect(isIdentityProviderDisableable(draft, 'no-history')).toBe(false);
    expect(isIdentityProviderDeletable(draft, 'no-history')).toBe(true);

    // Lookup loading/failure must not hide revocation or offer backend-rejected Delete.
    expect(isIdentityProviderDisableable(draft, 'unknown')).toBe(true);
    expect(isIdentityProviderDeletable(draft, 'unknown')).toBe(false);

    // Live statuses always disableable regardless of history map.
    for (const status of ['active', 'pending_restart', 'published', 'error'] as const) {
      expect(isIdentityProviderDisableable({ status }, 'no-history')).toBe(true);
      expect(isIdentityProviderDeletable({ status }, 'no-history')).toBe(false);
    }
    expect(isIdentityProviderDisableable({ status: 'disabled' }, 'has-history')).toBe(false);
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
    expect(AUTHENTIK_ISSUER_PLACEHOLDER).toContain('auth.example.com');
  });

  it('seeds the DingTalk template with its fixed issuer, icon and OAuth scopes', () => {
    const dingtalk = createIdentityProviderDraftFromTemplate('dingtalk');
    expect(dingtalk.type).toBe('dingtalk');
    expect(dingtalk.issuer).toBe(DINGTALK_IDENTITY_PROVIDER_ISSUER);
    expect(dingtalk.icon).toBe('dingtalk');
    expect(dingtalk.buttonLabel).toBe('使用钉钉登录');
    expect(dingtalk.scopes).toEqual(['openid', 'corpid']);
    // unionId ONLY — openId is app-scoped and would rebind identities after an AppKey change.
    expect(dingtalk.claimMapping.subject).toEqual(['unionId']);
    expect(dingtalk.claimMapping.name).toEqual(['nick']);
    expect(dingtalk.claimMapping.picture).toEqual(['avatarUrl']);
  });

  it('marks only fixed-protocol kinds as skipping the discovery and claims steps', () => {
    expect(isFixedProtocolIdentityProviderType('dingtalk')).toBe(true);
    expect(isFixedProtocolIdentityProviderType('authentik')).toBe(false);
    expect(isFixedProtocolIdentityProviderType('generic_oidc')).toBe(false);
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
      popup,
      result: { authorizationUrl: 'https://login.example.test/authorize' },
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
    ).toBe('failed');
    expect(
      resolveIdentityProviderRestartPhase({
        attempt,
        error: new Error('background refresh failed'),
        nowMonotonic: receivedAtMonotonic,
        phase: 'accepted',
        status: pending,
      }),
    ).toBe('failed');
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
    expect(
      resolveIdentityProviderRestartPhase({
        attempt,
        error: null,
        nowMonotonic: receivedAtMonotonic,
        phase: 'accepted',
        status: {
          ...pending,
          restartRequest: {
            requestId: 'request-1',
            resultCategory: 'signal_schedule_failed',
            status: 'failed',
          },
        },
      }),
    ).toBe('failed');
    // A failed request for a different restart must not poison this attempt.
    expect(
      resolveIdentityProviderRestartPhase({
        attempt,
        error: null,
        nowMonotonic: receivedAtMonotonic,
        phase: 'accepted',
        status: {
          ...pending,
          restartRequest: {
            requestId: 'other-request',
            resultCategory: 'signal_schedule_failed',
            status: 'failed',
          },
        },
      }),
    ).toBe('accepted');
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
    expect(
      resolveIdentityProviderRevisionRefresh({
        currentRevision: undefined,
        nextRevision: 0,
        preserveDraft: true,
      }),
    ).toBe('preserve');
    expect(
      resolveIdentityProviderRevisionRefresh({
        currentRevision: 0,
        nextRevision: 0,
        preserveDraft: false,
      }),
    ).toBe('unchanged');
  });

  describe('identity provider persist helpers', () => {
    it('allows a first-step save without issuer or client id', () => {
      expect(
        canPersistIdentityProviderDraft({
          displayName: 'Work',
          invalidJson: false,
          providerKey: 'work',
          providerKeyError: null,
        }),
      ).toBe(true);
      expect(
        canPersistIdentityProviderDraft({
          displayName: '',
          invalidJson: false,
          providerKey: 'work',
          providerKeyError: null,
        }),
      ).toBe(false);
      expect(
        toWritableIdentityProviderFields({
          autoProvision: true,
          buttonLabel: 'Sign in',
          claimMapping: {
            dingtalkTitle: [],
            dingtalkUserId: [],
            email: ['email'],
            name: ['name'],
            picture: [],
            subject: ['sub'],
          },
          clientId: '',
          dingtalkAllowedCorps: [],
          displayName: 'Work',
          domainAllowlist: [],
          groupRoleMapping: {},
          icon: null,
          issuer: '  ',
          providerKey: 'work',
          scopes: ['openid'],
          type: 'generic_oidc',
          usePkce: true,
        }),
      ).toMatchObject({ clientId: null, issuer: null });
    });

    it('never includes a typed secret on autosave and clears it on create', () => {
      expect(
        resolveIdentityProviderSecretMutation({
          clearSecret: false,
          isCreate: true,
          secret: 'typed-secret',
        }),
      ).toEqual({ operation: 'replace', value: 'typed-secret' });
      expect(
        resolveIdentityProviderSecretMutation({
          clearSecret: false,
          isCreate: true,
          secret: '',
        }),
      ).toEqual({ operation: 'clear' });
      expect(
        resolveIdentityProviderSecretMutation({
          clearSecret: false,
          isCreate: false,
          secret: '',
        }),
      ).toEqual({ operation: 'keep' });
      expect(formatIdentityProviderAutoSavedAt(new Date('2026-08-17T09:05:00'))).toBe('09:05');
    });

    it('skips persist unless content or an explicit secret mutation is dirty', () => {
      expect(
        shouldSkipIdentityProviderPersist({
          contentDirty: false,
          includeSecret: true,
          secretDirty: false,
        }),
      ).toBe(true);
      expect(
        shouldSkipIdentityProviderPersist({
          contentDirty: false,
          includeSecret: false,
          secretDirty: true,
        }),
      ).toBe(true);
      expect(
        shouldSkipIdentityProviderPersist({
          contentDirty: false,
          includeSecret: true,
          secretDirty: true,
        }),
      ).toBe(false);
      expect(
        shouldSkipIdentityProviderPersist({
          contentDirty: true,
          includeSecret: false,
          secretDirty: false,
        }),
      ).toBe(false);
    });

    it('closes after a successful persist unless a typed secret remains', () => {
      expect(resolveIdentityProviderWizardClose({ dirty: false, secretDirty: false })).toBe(
        'close',
      );
      expect(resolveIdentityProviderWizardClose({ dirty: true, secretDirty: false })).toBe(
        'persist',
      );
      expect(
        resolveIdentityProviderWizardClose({
          dirty: true,
          persistResult: 'saved',
          secretDirty: false,
        }),
      ).toBe('close');
      expect(
        resolveIdentityProviderWizardClose({
          dirty: true,
          persistResult: 'saved',
          secretDirty: true,
        }),
      ).toBe('confirm');
      expect(
        resolveIdentityProviderWizardClose({
          dirty: true,
          persistResult: 'conflict',
          secretDirty: false,
        }),
      ).toBe('stay');
      expect(
        resolveIdentityProviderWizardClose({
          dirty: true,
          persistResult: 'error',
          secretDirty: false,
        }),
      ).toBe('stay');
      expect(
        resolveIdentityProviderWizardClose({
          dirty: true,
          persistResult: 'blocked',
          secretDirty: false,
        }),
      ).toBe('confirm');
    });

    it('coalesces overlapping persist requests onto one follow-up call', async () => {
      const gate = createIdentityProviderPersistGate();
      let release!: () => void;
      const first = new Promise<void>((resolve) => {
        release = resolve;
      });
      const persist = vi
        .fn<(request: { includeSecret: boolean; silent: boolean }) => Promise<'saved'>>()
        .mockImplementationOnce(async () => {
          await first;
          return 'saved';
        })
        .mockResolvedValueOnce('saved');
      const cancelScheduled = vi.fn();

      const pendingFirst = gate.enqueue(
        { includeSecret: false, silent: true },
        persist,
        cancelScheduled,
      );
      const pendingSecond = gate.enqueue(
        { includeSecret: true, silent: false },
        persist,
        cancelScheduled,
      );
      expect(persist).toHaveBeenCalledTimes(1);
      release();
      await expect(Promise.all([pendingFirst, pendingSecond])).resolves.toEqual(['saved', 'saved']);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(persist.mock.calls[1]?.[0]).toEqual({ includeSecret: true, silent: false });
    });
  });

  it('prefers fresher list hits over retained mutation rows when present', () => {
    // Selector unit coverage only — the page-2 save→test/publish wiring is covered by
    // openIdentityProviderWizardModal.revision.test.tsx (identity/F8 mounted regression).
    expect(
      resolveIdentityProviderWizardLiveProvider({
        canonicalProvider: { id: 'idp-page-2', revision: 5 },
        isEdit: true,
        listHit: { id: 'idp-page-2', revision: 6 },
        propProvider: { id: 'idp-page-2', revision: 4 },
      }),
    ).toEqual({ id: 'idp-page-2', revision: 6 });
    expect(
      resolveIdentityProviderWizardLiveProvider({
        canonicalProvider: { id: 'idp-page-2', revision: 5 },
        isEdit: true,
        listHit: undefined,
        propProvider: { id: 'idp-page-2', revision: 4 },
      }),
    ).toEqual({ id: 'idp-page-2', revision: 5 });
  });
});

describe('DingTalk organisation allowlist helpers', () => {
  it('normalises notes only on serialization, so raw typing is preserved upstream', () => {
    expect(
      serializeIdentityProviderAllowedCorps([
        { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42', label: '  Head office  ' },
        { addedAt: '2026-01-02T00:00:00.000Z', corpId: 'ding43', label: '   ' },
        { addedAt: '2026-01-03T00:00:00.000Z', corpId: 'ding44' },
      ]),
    ).toEqual([
      { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42', label: 'Head office' },
      { addedAt: '2026-01-02T00:00:00.000Z', corpId: 'ding43' },
      { addedAt: '2026-01-03T00:00:00.000Z', corpId: 'ding44' },
    ]);
  });

  it('serializes an emptied organisation name to absent, like an emptied note', () => {
    expect(
      serializeIdentityProviderAllowedCorps([
        {
          addedAt: '2026-01-01T00:00:00.000Z',
          corpId: 'ding42',
          corpName: '  示例科技  ',
          label: 'HQ',
        },
        { addedAt: '2026-01-02T00:00:00.000Z', corpId: 'ding43', corpName: '   ' },
      ]),
    ).toEqual([
      { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42', corpName: '示例科技', label: 'HQ' },
      { addedAt: '2026-01-02T00:00:00.000Z', corpId: 'ding43' },
    ]);
  });
});

describe('safe-login failure messages', () => {
  it('maps known codes to actionable copy and falls back for the rest', () => {
    expect(identityProviderTestErrorKey('OIDC_TEST_REMOTE_INVALID')).toBe(
      'identityProviders.test.errors.remoteInvalid',
    );
    expect(identityProviderTestErrorKey('OIDC_TEST_CORP_ID_MISSING')).toBe(
      'identityProviders.test.errors.corpIdMissing',
    );
    expect(identityProviderTestErrorKey('OIDC_TEST_SOMETHING_NEW')).toBe(
      'identityProviders.test.errors.generic',
    );
    expect(identityProviderTestErrorKey(null)).toBe('identityProviders.test.errors.generic');
    // Prototype keys must not resolve inherited members.
    expect(identityProviderTestErrorKey('constructor')).toBe(
      'identityProviders.test.errors.generic',
    );
  });

  it('extracts the stable code from an arbitrary error payload', () => {
    expect(extractIdentityProviderTestErrorCode('boom OIDC_TEST_REMOTE_INVALID boom')).toBe(
      'OIDC_TEST_REMOTE_INVALID',
    );
    expect(
      extractIdentityProviderTestErrorCode({
        data: { errorData: { message: 'OIDC_TEST_CONFIG_INCOMPLETE' } },
      }),
    ).toBe('OIDC_TEST_CONFIG_INCOMPLETE');
    expect(extractIdentityProviderTestErrorCode('PLATFORM_REVISION_CONFLICT')).toBeNull();
    expect(extractIdentityProviderTestErrorCode(undefined)).toBeNull();
  });
});

describe('DingTalk permission remedies', () => {
  const remedy = (errorCode: string | null) =>
    identityProviderTestRemedyKey({ errorCode, type: 'dingtalk' });

  it('names the contact permission for every permission-shaped profile failure', () => {
    for (const errorCode of [
      'OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN',
      'OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN:Forbidden.AccessDenied.AccessTokenPermissionDenied',
      'OIDC_TEST_DINGTALK_PROFILE_REJECTED:Forbidden.AccessDenied.Something',
      'OIDC_TEST_DINGTALK_PROFILE_REJECTED:someCode.PermissionDenied',
    ]) {
      expect(remedy(errorCode), errorCode).toBe(
        'identityProviders.test.remedies.dingtalkContactPermission',
      );
    }
  });

  it('names the scope or credential to fix for the other known causes', () => {
    expect(remedy('OIDC_TEST_CORP_ID_MISSING')).toBe(
      'identityProviders.test.remedies.dingtalkCorpIdScope',
    );
    expect(remedy('OIDC_TEST_CLAIM_VALIDATION_FAILED')).toBe(
      'identityProviders.test.remedies.dingtalkProfileFields',
    );
    expect(remedy('OIDC_TEST_DINGTALK_TOKEN_REJECTED:invalidParameter.idOrSecret.notFound')).toBe(
      'identityProviders.test.remedies.dingtalkCredentials',
    );
  });

  it('offers no remedy when the cause is unknown or the kind is not DingTalk', () => {
    // A token rejection that is not a credential problem (e.g. redirect mismatch) keeps the
    // generic instruction rather than blaming the AppSecret.
    expect(remedy('OIDC_TEST_DINGTALK_TOKEN_REJECTED')).toBeNull();
    expect(remedy('OIDC_TEST_DINGTALK_TOKEN_REJECTED:some.other.code')).toBeNull();
    expect(remedy('OIDC_TEST_DINGTALK_PROFILE_REJECTED:invalidParameter.x')).toBeNull();
    expect(remedy('OIDC_TEST_FAILED')).toBeNull();
    expect(remedy(null)).toBeNull();
    // The same codes on an OIDC kind must not suggest DingTalk console steps.
    expect(
      identityProviderTestRemedyKey({
        errorCode: 'OIDC_TEST_CLAIM_VALIDATION_FAILED',
        type: 'generic_oidc',
      }),
    ).toBeNull();
  });

  it('composes cause + exact remedy + provider code into one message', () => {
    const translate = (key: string, options?: Record<string, unknown>) =>
      options?.code ? `${key}(${String(options.code)})` : key;

    expect(
      buildIdentityProviderTestFailureMessage(
        {
          errorCode:
            'OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN:Forbidden.AccessDenied.AccessTokenPermissionDenied',
          type: 'dingtalk',
        },
        translate,
      ),
    ).toBe(
      'identityProviders.test.errors.dingtalkProfileForbidden ' +
        'identityProviders.test.remedies.dingtalkContactPermission ' +
        'identityProviders.test.errors.providerCode(Forbidden.AccessDenied.AccessTokenPermissionDenied)',
    );

    // Unknown code: generic message + the raw code, no invented remedy.
    expect(
      buildIdentityProviderTestFailureMessage(
        { errorCode: 'OIDC_TEST_WHAT_IS_THIS:weird.code', type: 'dingtalk' },
        translate,
      ),
    ).toBe(
      'identityProviders.test.errors.generic identityProviders.test.errors.providerCode(weird.code)',
    );

    expect(
      buildIdentityProviderTestFailureMessage(
        { errorCode: 'OIDC_TEST_CORP_ID_MISSING', type: 'dingtalk' },
        translate,
      ),
    ).toBe(
      'identityProviders.test.errors.corpIdMissing identityProviders.test.remedies.dingtalkCorpIdScope',
    );
  });
});
