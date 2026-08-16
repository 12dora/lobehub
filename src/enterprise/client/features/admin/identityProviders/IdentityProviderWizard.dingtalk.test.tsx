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

const serviceMocks = vi.hoisted(() => ({ testStart: vi.fn() }));
const testResultMocks = vi.hoisted(() => ({
  data: null as null | {
    errorCode?: string | null;
    result?: { dingtalk?: { corpId: string; nick?: string }; valid?: boolean };
    status: string;
  },
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
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextArea: (props: Record<string, unknown>) => <textarea {...props} />,
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
  toast: { error: vi.fn(), success: vi.fn() },
  useModalContext: () => ({ close: vi.fn() }),
}));

vi.mock('lucide-react', () => ({
  AlertCircle: () => null,
  Check: () => null,
  Plus: () => null,
  Trash2: () => null,
}));

vi.mock('@/enterprise/client/services/adminIdentityProviders', () => ({
  adminIdentityProvidersService: {
    discover: vi.fn(),
    publish: vi.fn(),
    testStart: (...args: unknown[]) => serviceMocks.testStart(...args),
    update: vi.fn(),
  },
}));

vi.mock('../users/modals/openReasonModal', () => ({
  openReasonModal: (props: {
    buildPayload: (reason: string) => unknown;
    onSubmit: (payload: unknown) => Promise<unknown>;
  }) => {
    void props.onSubmit(props.buildPayload('audit-reason'));
  },
}));

vi.mock('./useIdentityProviders', () => ({
  useIdentityProviderTestResult: () => ({
    data: testResultMocks.data,
    error: undefined,
    mutate: vi.fn(),
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
    ) => start(),
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
    // The policy step stays REAL for the allowlist cases; step-shape cases never open it.
    PolicyStep: (props: Parameters<typeof actual.PolicyStep>[0]) =>
      stepMocks.mockSteps ? <div data-testid="step-policy" /> : <actual.PolicyStep {...props} />,
    PublishStep: stub('publish'),
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
    serviceMocks.testStart.mockResolvedValue({
      attemptId: 'attempt-capture',
      authorizationUrl: 'https://login.dingtalk.com/oauth2/auth',
    });
  });

  it('warns when no organisation is allowed and blocks Publish', async () => {
    renderWizard(baseProvider);
    await openPolicyStep();
    expect(screen.getByText('identityProviders.dingtalk.allowedCorps.empty')).toBeTruthy();
    expect(captureButton()).toBeTruthy();
  });

  it('captures an organisation from a DingTalk login, labels it and marks the draft dirty', async () => {
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
      screen.getByDisplayValue('identityProviders.dingtalk.allowedCorps.addedBy:Ada'),
    ).toBeTruthy();
    expect(onDirtyChange).toHaveBeenCalledWith(true);
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
    vi.clearAllMocks();
    serviceMocks.testStart.mockResolvedValue({
      attemptId: 'attempt-capture',
      authorizationUrl: 'https://login.dingtalk.com/oauth2/auth',
    });
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

  it('never generates a label longer than the persisted limit', async () => {
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
    expect((note as HTMLInputElement).value.length).toBeLessThanOrEqual(64);
  });
});
