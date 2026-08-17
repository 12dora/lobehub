/**
 * ASI-009: Publish button readiness matrix.
 *
 * untested | failed | passed-current-revision | passed-stale-revision
 * (test at rev N → save → rev N+1 must disable Publish).
 *
 * @vitest-environment happy-dom
 */
import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import IdentityProviderWizard from './IdentityProviderWizard';

const serviceMocks = vi.hoisted(() => ({
  publish: vi.fn(),
  testStart: vi.fn(),
  update: vi.fn(),
}));

const testResultMocks = vi.hoisted(() => ({
  data: null as null | { result?: { valid?: boolean }; status: string },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
  keyframes: () => '',
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  copyToClipboard: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    loading?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled || loading} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal: vi.fn(),
  createModal: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
  useModalContext: () => ({ close: vi.fn() }),
}));

vi.mock('lucide-react', () => ({
  AlertCircle: () => null,
  Ban: () => null,
  Check: () => null,
  CheckCircle2: () => null,
  Clock3: () => null,
  FileText: () => null,
}));

vi.mock('@/enterprise/client/services/adminIdentityProviders', () => ({
  adminIdentityProvidersService: {
    publish: (...args: unknown[]) => serviceMocks.publish(...args),
    testStart: (...args: unknown[]) => serviceMocks.testStart(...args),
    update: (...args: unknown[]) => serviceMocks.update(...args),
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

vi.mock('./steps', () => ({
  BasicStep: ({
    draft,
    patch,
  }: {
    draft: { displayName: string };
    patch: (key: 'displayName', value: string) => void;
  }) => (
    <div data-testid="step-basic">
      <input
        aria-label="displayName"
        value={draft.displayName}
        onChange={(event) => patch('displayName', event.target.value)}
      />
    </div>
  ),
  ClaimsStep: () => <div data-testid="step-claims" />,
  ClientStep: () => <div data-testid="step-client" />,
  DiscoveryStep: () => <div data-testid="step-discovery" />,
  PolicyStep: () => <div data-testid="step-policy" />,
  PublishStep: ({ onStartTest }: { onStartTest?: () => void }) => (
    <div data-testid="step-publish">
      <button data-testid="wizard-start-test" type="button" onClick={() => onStartTest?.()}>
        start-test
      </button>
    </div>
  ),
}));

vi.mock('./controller', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('./controller')>();
  return {
    ...actual,
    openIdentityProviderTestPopup: async <Result extends { authorizationUrl?: string }>(
      start: () => Promise<Result>,
    ) => ({
      popup: { closed: false, close: vi.fn(), location: { assign: vi.fn() } } as unknown as Window,
      result: await start(),
    }),
  };
});

const baseProvider: PlatformIdentityProviderDraft = {
  activationRevision: null,
  autoProvision: true,
  buttonLabel: 'Work login',
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: [],
    email: ['email'],
    name: ['name'],
    picture: ['picture'],
    subject: ['sub'],
  },
  clientId: 'client-1',
  dingtalkAllowedCorps: [],
  displayName: 'Gate Provider',
  domainAllowlist: ['example.test'],
  enabled: true,
  groupRoleMapping: {},
  icon: null,
  id: 'idp-gate',
  issuer: 'https://idp.example.test/',
  migrationRequired: false,
  providerKey: 'gate-oidc',
  publishTestReady: false,
  revision: 5,
  scopes: ['openid', 'profile', 'email'],
  secret: { configured: true, updatedAt: new Date('2026-01-01T00:00:00.000Z') },
  status: 'draft',
  type: 'generic_oidc',
  usePkce: true,
};

const goToPublishStep = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText(/identityProviders\.steps\.publish/));
  });
  await waitFor(() => {
    expect(screen.getByTestId('step-publish')).toBeTruthy();
  });
};

const publishButton = () =>
  screen.getByRole('button', { name: 'identityProviders.actions.publish' });

describe('IdentityProviderWizard publish gate matrix (ASI-009)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testResultMocks.data = null;
    serviceMocks.testStart.mockResolvedValue({
      attemptId: 'attempt-gate',
      authorizationUrl: 'https://idp.example.test/authorize',
    });
    serviceMocks.update.mockImplementation(async (input: { expectedRevision: number }) => ({
      ...baseProvider,
      publishTestReady: false,
      revision: input.expectedRevision + 1,
    }));
  });

  it('disables Publish when never tested (untested)', async () => {
    render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={{ ...baseProvider, publishTestReady: false, revision: 5 }}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await goToPublishStep();
    expect(publishButton()).toBeDisabled();
  });

  it('disables Publish when the session test failed', async () => {
    testResultMocks.data = { result: { valid: false }, status: 'failed' };
    const { rerender } = render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={{ ...baseProvider, publishTestReady: false, revision: 5 }}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await goToPublishStep();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-start-test'));
    });
    await waitFor(() => {
      expect(serviceMocks.testStart).toHaveBeenCalled();
    });
    // Force re-read of failed result after attempt is set.
    rerender(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={{ ...baseProvider, publishTestReady: false, revision: 5 }}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(publishButton()).toBeDisabled();
  });

  it('enables Publish after a successful test on the current revision', async () => {
    testResultMocks.data = { result: { valid: true }, status: 'succeeded' };
    const { rerender } = render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={{ ...baseProvider, publishTestReady: false, revision: 5 }}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await goToPublishStep();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-start-test'));
    });
    await waitFor(() => {
      expect(serviceMocks.testStart).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 5 }),
      );
    });
    rerender(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={{ ...baseProvider, publishTestReady: false, revision: 5 }}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(publishButton()).not.toBeDisabled();
    });
  });

  it('disables Publish after save bumps revision (passed-stale-revision)', async () => {
    testResultMocks.data = { result: { valid: true }, status: 'succeeded' };
    let live: PlatformIdentityProviderDraft = {
      ...baseProvider,
      publishTestReady: false,
      revision: 5,
    };
    const onSaved = vi.fn(async (saved?: PlatformIdentityProviderDraft) => {
      if (saved) live = saved;
    });

    const { rerender } = render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={live}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await goToPublishStep();

    // Successful test at revision 5.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-start-test'));
    });
    await waitFor(() => {
      expect(serviceMocks.testStart).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 5 }),
      );
    });
    rerender(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={live}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await waitFor(() => {
      expect(publishButton()).not.toBeDisabled();
    });

    // Edit + save → revision 6, publishTestReady false (server keys attempt to revision).
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.basic/));
    });
    fireEvent.change(screen.getByLabelText('displayName'), {
      target: { value: `${live.displayName} edited` },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('identityProviders.actions.save'));
    });
    await waitFor(() => {
      expect(serviceMocks.update).toHaveBeenCalled();
      expect(onSaved).toHaveBeenCalled();
    });
    expect(live.revision).toBe(6);
    expect(live.publishTestReady).toBe(false);

    await goToPublishStep();

    // Re-render with the post-save provider (modal stays open across saves — no remount key).
    rerender(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={live}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={onSaved}
      />,
    );

    // Stale session success at rev 5 must NOT keep Publish enabled at rev 6.
    await waitFor(() => {
      expect(publishButton()).toBeDisabled();
    });
  });

  it('enables Publish when server publishTestReady is true for the current revision', async () => {
    testResultMocks.data = null;
    render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={{ ...baseProvider, publishTestReady: true, revision: 5 }}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await goToPublishStep();
    expect(publishButton()).not.toBeDisabled();
  });
});
