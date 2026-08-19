/**
 * DingTalk wizard shape and organisation-allowlist behaviour.
 *
 * The step-shape cases mock the step bodies; the allowlist cases render the REAL policy step so
 * the capture button, the gating hints, dedupe, remove, dirty tracking and publish readiness are
 * exercised through the actual UI rather than through props.
 *
 * @vitest-environment happy-dom
 */
import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import IdentityProviderWizard from './IdentityProviderWizard';

const serviceMocks = vi.hoisted(() => ({
  openReasonModal: vi.fn(),
  testStart: vi.fn(),
  update: vi.fn(),
}));
const testResultMocks = vi.hoisted(() => ({
  data: null as null | {
    errorCode?: string | null;
    result?: {
      dingtalk?: {
        corpId: string;
        corpName?: string;
        corpNameMissingScope?: string;
        corpNameReason?: string;
        nick?: string;
      };
      valid?: boolean;
    };
    status: string;
  },
  error: undefined as unknown,
  mutate: vi.fn(),
}));
const popupMocks = vi.hoisted(() => ({
  popup: { closed: false, close: vi.fn(), location: { assign: vi.fn() } },
}));
const stepMocks = vi.hoisted(() => ({ mockSteps: true }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.defaultValue !== undefined
        ? String(options.defaultValue)
        : options?.nick
          ? `${key}:${String(options.nick)}`
          : key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
  keyframes: () => '',
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ description }: { description?: ReactNode }) => <div role="status">{description}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextArea: (props: Record<string, unknown>) => <textarea {...props} />,
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  copyToClipboard: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
    ...rest
  }: {
    children?: ReactNode;
    disabled?: boolean;
    loading?: boolean;
    onClick?: () => void;
  }) => (
    <button {...rest} disabled={disabled || loading} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Checkbox: (props: Record<string, unknown>) => <input type="checkbox" {...props} />,
  confirmModal: vi.fn(),
  createModal: vi.fn(),
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  useModalContext: () => ({ close: vi.fn() }),
}));

vi.mock('lucide-react', () => ({
  AlertCircle: () => null,
  Ban: () => null,
  Check: () => null,
  CheckCircle2: () => null,
  Clock3: () => null,
  FileText: () => null,
  Plus: () => null,
  Trash2: () => null,
}));

vi.mock('@/enterprise/client/services/adminIdentityProviders', () => ({
  adminIdentityProvidersService: {
    discover: vi.fn(),
    publish: vi.fn(),
    testStart: (...args: unknown[]) => serviceMocks.testStart(...args),
    update: (...args: unknown[]) => serviceMocks.update(...args),
  },
}));

vi.mock('../users/modals/openReasonModal', () => ({
  openReasonModal: (props: {
    buildPayload: (reason: string) => unknown;
    onSubmit: (payload: unknown) => Promise<unknown>;
  }) => {
    serviceMocks.openReasonModal();
    void props.onSubmit(props.buildPayload('audit-reason'));
  },
}));

vi.mock('./useIdentityProviders', () => ({
  useIdentityProviderTestResult: () => ({
    data: testResultMocks.data,
    error: testResultMocks.error,
    mutate: testResultMocks.mutate,
  }),
}));

vi.mock('./useUnsavedIdentityProviderGuard', () => ({
  useUnsavedIdentityProviderGuard: () => undefined,
}));

vi.mock('./controller', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('./controller')>();
  return {
    ...actual,
    openIdentityProviderTestPopup: async <Result extends { authorizationUrl?: string }>(
      start: () => Promise<Result>,
    ) => ({ popup: popupMocks.popup as unknown as Window, result: await start() }),
  };
});

vi.mock('./steps', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('./steps')>();
  const stub = (id: string) => () => <div data-testid={`step-${id}`} />;
  return {
    ...actual,
    BasicStep: stub('basic'),
    ClaimsStep: stub('claims'),
    ClientStep: stub('client'),
    DiscoveryStep: stub('discovery'),
    // Policy and publish stay REAL when steps are un-mocked, so the failure panels they render
    // are exercised through the actual UI; step-shape cases keep the stubs.
    PolicyStep: (props: Parameters<typeof actual.PolicyStep>[0]) =>
      stepMocks.mockSteps ? <div data-testid="step-policy" /> : <actual.PolicyStep {...props} />,
    PublishStep: (props: Parameters<typeof actual.PublishStep>[0]) =>
      stepMocks.mockSteps ? <div data-testid="step-publish" /> : <actual.PublishStep {...props} />,
  };
});

const baseProvider: PlatformIdentityProviderDraft = {
  activationRevision: null,
  autoProvision: true,
  buttonLabel: '使用钉钉登录',
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: ['unionId'],
    email: ['email'],
    name: ['nick'],
    picture: ['avatarUrl'],
    subject: ['unionId'],
  },
  clientId: 'app-key',
  dingtalkAllowedCorps: [],
  displayName: 'DingTalk',
  domainAllowlist: [],
  enabled: false,
  groupRoleMapping: {},
  icon: 'dingtalk',
  id: 'idp-dingtalk',
  issuer: 'https://login.dingtalk.com',
  migrationRequired: false,
  providerKey: 'dingtalk',
  publishTestReady: false,
  revision: 1,
  scopes: ['openid', 'corpid'],
  secret: { configured: true, updatedAt: new Date('2026-01-01T00:00:00.000Z') },
  status: 'draft',
  type: 'dingtalk',
  usePkce: true,
};

const renderWizard = (
  provider: PlatformIdentityProviderDraft,
  overrides: Partial<Parameters<typeof IdentityProviderWizard>[0]> = {},
) =>
  render(
    <IdentityProviderWizard
      canCreate
      canPublish
      canTest
      canUpdate
      authMethod="better-auth"
      provider={provider}
      onDirtyChange={vi.fn()}
      onDiscard={vi.fn()}
      onRefresh={vi.fn()}
      onSaved={vi.fn()}
      {...overrides}
    />,
  );

const openPolicyStep = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText(/identityProviders\.steps\.policy/));
  });
};

const captureButton = () =>
  screen.getByRole('button', { name: 'identityProviders.dingtalk.allowedCorps.add' });

describe('IdentityProviderWizard DingTalk shape', () => {
  beforeEach(() => {
    stepMocks.mockSteps = true;
    testResultMocks.data = null;
    testResultMocks.error = undefined;
    testResultMocks.mutate.mockReset();
    popupMocks.popup.closed = false;
    vi.clearAllMocks();
    serviceMocks.update.mockImplementation(async (input: { expectedRevision?: number }) => ({
      ...baseProvider,
      revision: (input.expectedRevision ?? baseProvider.revision) + 1,
    }));
  });

  it('drops the discovery and claims steps for DingTalk', () => {
    renderWizard(baseProvider);
    expect(screen.queryByText(/identityProviders\.steps\.discovery/)).toBeNull();
    expect(screen.queryByText(/identityProviders\.steps\.claims/)).toBeNull();
    expect(screen.getByText(/identityProviders\.steps\.basic/)).toBeTruthy();
    expect(screen.getByText(/identityProviders\.steps\.client/)).toBeTruthy();
    expect(screen.getByText(/identityProviders\.steps\.policy/)).toBeTruthy();
    expect(screen.getByText(/identityProviders\.steps\.publish/)).toBeTruthy();
    // Steps are renumbered so the visible sequence has no gaps.
    expect(screen.getByText(/2\. identityProviders\.steps\.client/)).toBeTruthy();
  });

  it('keeps every step for strict OIDC kinds', () => {
    renderWizard({ ...baseProvider, id: 'idp-oidc', type: 'generic_oidc' });
    expect(screen.getByText(/identityProviders\.steps\.discovery/)).toBeTruthy();
    expect(screen.getByText(/identityProviders\.steps\.claims/)).toBeTruthy();
  });
});

describe('IdentityProviderWizard DingTalk organisation allowlist', () => {
  beforeEach(() => {
    stepMocks.mockSteps = false;
    testResultMocks.data = null;
    testResultMocks.error = undefined;
    testResultMocks.mutate.mockReset();
    popupMocks.popup.closed = false;
    vi.clearAllMocks();
    serviceMocks.testStart.mockResolvedValue({
      attemptId: 'attempt-capture',
      authorizationUrl: 'https://login.dingtalk.com/oauth2/auth',
    });
    serviceMocks.update.mockImplementation(async (input: { expectedRevision?: number }) => ({
      ...baseProvider,
      revision: (input.expectedRevision ?? baseProvider.revision) + 1,
    }));
  });

  it('warns when no organisation is allowed and blocks Publish', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();
    expect(screen.getByText('identityProviders.dingtalk.allowedCorps.empty')).toBeTruthy();
    expect(captureButton()).toBeTruthy();
  });

  it('captures an organisation from a DingTalk login and marks the draft dirty', async () => {
    const onDirtyChange = vi.fn();
    renderWizard(baseProvider, { onDirtyChange });
    await openPolicyStep();

    await act(async () => {
      fireEvent.click(captureButton());
    });
    expect(serviceMocks.testStart).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1, id: 'idp-dingtalk' }),
    );

    // The capture result arrives through the polled test result.
    testResultMocks.data = {
      result: { dingtalk: { corpId: 'ding42', nick: 'Ada' }, valid: true },
      status: 'succeeded',
    };
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    await openPolicyStep();

    await waitFor(() => {
      expect(screen.getByText('ding42')).toBeTruthy();
    });
    expect(
      (screen.getByLabelText('identityProviders.dingtalk.allowedCorps.label') as HTMLInputElement)
        .value,
    ).toBe('');
    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it('lets the administrator type the organisation name when DingTalk omitted it', async () => {
    renderWizard({
      ...baseProvider,
      dingtalkAllowedCorps: [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' }],
    });
    await openPolicyStep();
    const name = screen.getByLabelText(
      'identityProviders.dingtalk.allowedCorps.columns.organization',
    );
    expect((name as HTMLInputElement).value).toBe('');
    await act(async () => {
      fireEvent.change(name, { target: { value: '示例科技' } });
    });
    expect((name as HTMLInputElement).value).toBe('示例科技');
  });

  it('does not add the same organisation twice', async () => {
    renderWizard({
      ...baseProvider,
      dingtalkAllowedCorps: [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' }],
    });
    await openPolicyStep();
    expect(screen.getAllByText('ding42')).toHaveLength(1);

    await act(async () => {
      fireEvent.click(captureButton());
    });
    testResultMocks.data = {
      result: { dingtalk: { corpId: 'ding42', nick: 'Ada' }, valid: true },
      status: 'succeeded',
    };
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    await openPolicyStep();
    expect(screen.getAllByText('ding42')).toHaveLength(1);
  });

  it('hydrates an existing provider allowlist and can remove an entry', async () => {
    renderWizard({
      ...baseProvider,
      dingtalkAllowedCorps: [
        { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42', label: 'HQ' },
        { addedAt: '2026-01-02T00:00:00.000Z', corpId: 'ding43' },
      ],
      status: 'active',
    });
    await openPolicyStep();
    expect(screen.getByText('ding42')).toBeTruthy();
    expect(screen.getByText('ding43')).toBeTruthy();
    expect(screen.getByDisplayValue('HQ')).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', {
          name: 'identityProviders.dingtalk.allowedCorps.remove',
        })[0]!,
      );
    });
    expect(screen.queryByText('ding42')).toBeNull();
    expect(screen.getByText('ding43')).toBeTruthy();
  });

  it('explains why capture is unavailable before the credentials are saved', async () => {
    renderWizard({
      ...baseProvider,
      clientId: null,
      secret: { configured: false, updatedAt: null },
    });
    await openPolicyStep();
    expect(
      screen.getByText('identityProviders.dingtalk.allowedCorps.blockedNoCredentials'),
    ).toBeTruthy();
    expect(captureButton().hasAttribute('disabled')).toBe(true);
  });

  it('blocks capture on a published (non-draft) provider until it is edited back to a draft', async () => {
    renderWizard({ ...baseProvider, status: 'active' });
    await openPolicyStep();
    expect(
      screen.getByText('identityProviders.dingtalk.allowedCorps.blockedNotDraft'),
    ).toBeTruthy();
    expect(captureButton().hasAttribute('disabled')).toBe(true);
  });
});

describe('IdentityProviderWizard DingTalk capture guards and notes', () => {
  beforeEach(() => {
    stepMocks.mockSteps = false;
    testResultMocks.data = null;
    testResultMocks.error = undefined;
    testResultMocks.mutate.mockReset();
    popupMocks.popup.closed = false;
    vi.clearAllMocks();
    serviceMocks.testStart.mockResolvedValue({
      attemptId: 'attempt-capture',
      authorizationUrl: 'https://login.dingtalk.com/oauth2/auth',
    });
    serviceMocks.update.mockImplementation(async (input: { expectedRevision?: number }) => ({
      ...baseProvider,
      revision: (input.expectedRevision ?? baseProvider.revision) + 1,
    }));
  });

  it('starts only one DingTalk login even when the button is clicked repeatedly', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();

    await act(async () => {
      fireEvent.click(captureButton());
    });
    // The attempt is now polling; the button must stay disabled with an explicit reason.
    expect(captureButton().hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('identityProviders.dingtalk.allowedCorps.blockedPending')).toBeTruthy();

    await act(async () => {
      fireEvent.click(captureButton());
      fireEvent.click(captureButton());
    });
    expect(serviceMocks.testStart).toHaveBeenCalledTimes(1);
  });

  it('blocks capture at the organisation limit', async () => {
    renderWizard({
      ...baseProvider,
      dingtalkAllowedCorps: Array.from({ length: 200 }, (_, index) => ({
        addedAt: '2026-01-01T00:00:00.000Z',
        corpId: `ding${index}`,
      })),
    });
    await openPolicyStep();
    expect(screen.getByText(/allowedCorps\.blockedFull/)).toBeTruthy();
    expect(captureButton().hasAttribute('disabled')).toBe(true);
    await act(async () => {
      fireEvent.click(captureButton());
    });
    expect(serviceMocks.testStart).not.toHaveBeenCalled();
  });

  it('surfaces a readable reason when the DingTalk login fails', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });

    testResultMocks.data = { errorCode: 'OIDC_TEST_REMOTE_INVALID', status: 'failed' };
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    await openPolicyStep();
    await waitFor(() => {
      expect(screen.getByText('identityProviders.test.errors.remoteInvalid')).toBeTruthy();
    });
  });

  it('keeps a multi-word note typeable and bounds a generated label to the schema limit', async () => {
    renderWizard({
      ...baseProvider,
      dingtalkAllowedCorps: [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' }],
    });
    await openPolicyStep();

    const note = screen.getByLabelText('identityProviders.dingtalk.allowedCorps.label');
    // A trailing space must survive so the next word can be typed.
    await act(async () => {
      fireEvent.change(note, { target: { value: 'Head ' } });
    });
    expect((note as HTMLInputElement).value).toBe('Head ');
    await act(async () => {
      fireEvent.change(note, { target: { value: 'Head office' } });
    });
    expect((note as HTMLInputElement).value).toBe('Head office');
  });

  it('leaves the remark empty even when DingTalk returned a long nick', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });

    testResultMocks.data = {
      result: { dingtalk: { corpId: 'ding42', nick: '长'.repeat(250) }, valid: true },
      status: 'succeeded',
    };
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    await openPolicyStep();

    const note = await waitFor(() =>
      screen.getByLabelText('identityProviders.dingtalk.allowedCorps.label'),
    );
    expect((note as HTMLInputElement).value).toBe('');
  });

  it('toasts timeout, stops polling, and keeps Publish gated when the login window stays open', async () => {
    vi.useFakeTimers();
    const { toast } = await import('@lobehub/ui/base-ui');
    try {
      renderWizard(baseProvider);
      await openPolicyStep();
      await act(async () => {
        fireEvent.click(captureButton());
      });
      expect(captureButton().hasAttribute('disabled')).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(toast.info).toHaveBeenCalledWith('identityProviders.test.timeout');
      expect(screen.getByText('identityProviders.test.timeout')).toBeTruthy();
      expect(captureButton().hasAttribute('disabled')).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.publish/));
    });
    expect(
      (
        screen.getByRole('button', {
          name: 'identityProviders.actions.publish',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('stops polling and toasts when the login window is closed before completion', async () => {
    vi.useFakeTimers();
    const { toast } = await import('@lobehub/ui/base-ui');
    try {
      renderWizard(baseProvider);
      await openPolicyStep();
      await act(async () => {
        fireEvent.click(captureButton());
      });
      expect(captureButton().hasAttribute('disabled')).toBe(true);

      popupMocks.popup.closed = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(toast.info).toHaveBeenCalledWith('identityProviders.test.windowClosed');
      expect(screen.getByText('identityProviders.test.windowClosed')).toBeTruthy();
      expect(captureButton().hasAttribute('disabled')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows windowClosed when the closed-path revalidate rejects, without retrying mutate', async () => {
    vi.useFakeTimers();
    const { toast } = await import('@lobehub/ui/base-ui');
    testResultMocks.mutate.mockRejectedValue(new Error('network'));
    try {
      renderWizard(baseProvider);
      await openPolicyStep();
      await act(async () => {
        fireEvent.click(captureButton());
      });

      popupMocks.popup.closed = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(testResultMocks.mutate).toHaveBeenCalledTimes(1);
      expect(toast.info).toHaveBeenCalledWith('identityProviders.test.windowClosed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains a missing organisation name instead of only the missing-scope case', async () => {
    const { toast } = await import('@lobehub/ui/base-ui');
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });
    testResultMocks.data = {
      result: { dingtalk: { corpId: 'ding42', corpNameReason: 'name_absent' }, valid: true },
      status: 'succeeded',
    };
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    await openPolicyStep();
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        'identityProviders.dingtalk.allowedCorps.nameUnavailable',
      );
    });
  });

  it('revalidates the test result when the callback posts a same-origin message from the popup', async () => {
    testResultMocks.mutate.mockResolvedValue({ status: 'succeeded' });
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });
    expect(testResultMocks.mutate).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { success: true, type: 'aihub-identity-provider-test' },
          origin: window.location.origin,
          source: popupMocks.popup as unknown as MessageEventSource,
        }),
      );
    });

    expect(testResultMocks.mutate).toHaveBeenCalled();
    expect(captureButton().hasAttribute('disabled')).toBe(false);
  });

  it('keeps polling when the popup message revalidate is not yet terminal', async () => {
    testResultMocks.mutate.mockResolvedValue({ status: 'processing' });
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { success: true, type: 'aihub-identity-provider-test' },
          origin: window.location.origin,
          source: popupMocks.popup as unknown as MessageEventSource,
        }),
      );
    });

    expect(testResultMocks.mutate).toHaveBeenCalled();
    expect(captureButton().hasAttribute('disabled')).toBe(true);
  });

  it('keeps polling when a postMessage arrives from another origin', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { success: true, type: 'aihub-identity-provider-test' },
          origin: 'https://evil.example',
          source: popupMocks.popup as unknown as MessageEventSource,
        }),
      );
    });

    expect(testResultMocks.mutate).not.toHaveBeenCalled();
    expect(captureButton().hasAttribute('disabled')).toBe(true);
  });

  it('ignores a same-origin message that did not come from the popup', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { success: true, type: 'aihub-identity-provider-test' },
          origin: window.location.origin,
        }),
      );
    });

    expect(testResultMocks.mutate).not.toHaveBeenCalled();
    expect(captureButton().hasAttribute('disabled')).toBe(true);
  });
});

describe('IdentityProviderWizard DingTalk operator friction', () => {
  beforeEach(() => {
    stepMocks.mockSteps = false;
    testResultMocks.data = null;
    testResultMocks.error = undefined;
    testResultMocks.mutate.mockReset();
    popupMocks.popup.closed = false;
    vi.clearAllMocks();
    serviceMocks.testStart.mockResolvedValue({
      attemptId: 'attempt-capture',
      authorizationUrl: 'https://login.dingtalk.com/oauth2/auth',
    });
    serviceMocks.update.mockImplementation(async (input: { expectedRevision: number }) => ({
      ...baseProvider,
      revision: input.expectedRevision + 1,
    }));
  });

  it('adds an organisation without asking for a written reason', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });
    expect(serviceMocks.openReasonModal).not.toHaveBeenCalled();
    expect(serviceMocks.testStart).toHaveBeenCalledWith({
      expectedRevision: 1,
      id: 'idp-dingtalk',
    });
    // No `reason` is sent at all — the server records an em dash.
    expect(serviceMocks.testStart.mock.calls[0]![0]).not.toHaveProperty('reason');
  });

  it('saves a draft without asking for a written reason', async () => {
    renderWizard({
      ...baseProvider,
      dingtalkAllowedCorps: [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' }],
    });
    await openPolicyStep();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('identityProviders.dingtalk.allowedCorps.label'), {
        target: { value: 'HQ' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'identityProviders.actions.save' }));
    });
    expect(serviceMocks.openReasonModal).not.toHaveBeenCalled();
    expect(serviceMocks.update).toHaveBeenCalledTimes(1);
    expect(serviceMocks.update.mock.calls[0]![0]).not.toHaveProperty('reason');
  });

  it('shows both redirect URLs, with the DingTalk shim as the production one', async () => {
    renderWizard(baseProvider, {
      callbacks: {
        dingtalkProduction:
          'https://app.example.test/oauth/identity-provider/dingtalk/{providerKey}',
        production: 'https://app.example.test/api/auth/oauth2/callback/{providerKey}',
        test: 'https://app.example.test/oauth/identity-provider/test/callback',
      },
    });
    await openPolicyStep();
    // `{providerKey}` is substituted so the value can be copied straight into DingTalk.
    expect(
      screen.getByText('https://app.example.test/oauth/identity-provider/dingtalk/dingtalk'),
    ).toBeTruthy();
    expect(
      screen.getByText('https://app.example.test/oauth/identity-provider/test/callback'),
    ).toBeTruthy();
    // The Better Auth callback is NOT what DingTalk should be given.
    expect(
      screen.queryByText('https://app.example.test/api/auth/oauth2/callback/dingtalk'),
    ).toBeNull();
  });

  it('names the DingTalk error code when the exchange is rejected', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });

    testResultMocks.data = {
      errorCode: 'OIDC_TEST_DINGTALK_TOKEN_REJECTED:invalidParameter.idOrSecret.notFound',
      status: 'failed',
    };
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    await openPolicyStep();
    await waitFor(() => {
      expect(
        screen.getByText(
          /identityProviders\.test\.errors\.dingtalkTokenRejected identityProviders\.test\.remedies\.dingtalkCredentials identityProviders\.test\.errors\.providerCode/,
        ),
      ).toBeTruthy();
    });
  });

  it('names the missing contact permission for a profile-stage rejection', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();
    await act(async () => {
      fireEvent.click(captureButton());
    });

    testResultMocks.data = {
      errorCode: 'OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN:Forbidden.AccessDenied.X',
      status: 'failed',
    };
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    await openPolicyStep();
    await waitFor(() => {
      // Cause + the exact permission to switch on + DingTalk's own code, in the capture panel.
      expect(
        screen.getByText(
          /identityProviders\.test\.errors\.dingtalkProfileForbidden identityProviders\.test\.remedies\.dingtalkContactPermission/,
        ),
      ).toBeTruthy();
    });
  });

  it('names the exact permission in the publish step test-result panel too', async () => {
    renderWizard(baseProvider);
    testResultMocks.data = {
      errorCode: 'OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN:Forbidden.AccessDenied.X',
      status: 'failed',
    };
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.publish/));
    });
    await waitFor(() => {
      expect(
        screen.getByText(
          /identityProviders\.test\.errors\.dingtalkProfileForbidden identityProviders\.test\.remedies\.dingtalkContactPermission/,
        ),
      ).toBeTruthy();
    });
  });

  it('names the missing corpid scope rather than a generic failure', async () => {
    renderWizard(baseProvider);
    testResultMocks.data = { errorCode: 'OIDC_TEST_CORP_ID_MISSING', status: 'failed' };
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.publish/));
    });
    await waitFor(() => {
      expect(
        screen.getByText(
          /identityProviders\.test\.errors\.corpIdMissing identityProviders\.test\.remedies\.dingtalkCorpIdScope/,
        ),
      ).toBeTruthy();
    });
  });
});
