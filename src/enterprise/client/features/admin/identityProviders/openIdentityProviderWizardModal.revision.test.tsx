/**
 * identity/F8: mounted modal + REAL IdentityProviderWizard revision retention.
 *
 * Mounts IdentityProviderWizardModalContent with the production wizard (not a hand-built
 * stand-in). save→test→publish run through real actions so expectedRevision threads from
 * the retained mutation response (4→5, publish with expectedRevision: 5).
 *
 * Reverting setCanonicalProvider(saved) in the modal, or stopping the wizard from using
 * provider.revision for CAS, fails this test.
 *
 * @vitest-environment happy-dom
 */
import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// REAL modal content + REAL IdentityProviderWizard (not mocked).
import { IdentityProviderWizardModalContent } from './openIdentityProviderWizardModal';

const serviceMocks = vi.hoisted(() => ({
  publish: vi.fn(),
  testStart: vi.fn(),
  update: vi.fn(),
}));

const reasonModalMocks = vi.hoisted(() => ({
  openReasonModal: vi.fn(),
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
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  Check: () => null,
}));

vi.mock('@/enterprise/client/services/adminIdentityProviders', () => ({
  adminIdentityProvidersService: {
    publish: (...args: unknown[]) => serviceMocks.publish(...args),
    testStart: (...args: unknown[]) => serviceMocks.testStart(...args),
    update: (...args: unknown[]) => serviceMocks.update(...args),
  },
}));

// Auto-submit reason modal so save/test/publish reach the real service calls.
vi.mock('../users/modals/openReasonModal', () => ({
  openReasonModal: (props: {
    buildPayload: (reason: string) => unknown;
    onSubmit: (payload: unknown) => Promise<unknown>;
  }) => {
    reasonModalMocks.openReasonModal(props);
    void props.onSubmit(props.buildPayload('audit-reason'));
  },
}));

vi.mock('./useIdentityProviders', () => ({
  useIdentityProviderCallbacks: () => ({ data: undefined }),
  useIdentityProviderTestResult: () => ({
    data: { result: { valid: true }, status: 'succeeded' },
    error: undefined,
    mutate: vi.fn(),
  }),
  // Page-scoped list miss: page-2 provider is absent from the first-page cache.
  useIdentityProviders: () => ({
    data: { items: [], nextCursor: null },
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('./useUnsavedIdentityProviderGuard', () => ({
  useUnsavedIdentityProviderGuard: () => undefined,
}));

vi.mock('./IdentityProviderTypePicker', () => ({
  default: () => null,
}));

// Leaf steps are presentational; keep them light so collection stays fast while the
// wizard shell (save/test/publish + provider.revision CAS) remains the real module.
vi.mock('./steps', () => ({
  BasicStep: () => <div data-testid="step-basic" />,
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
    // Bypass popup plumbing; still invoke the real testStart path with CAS args.
    openIdentityProviderTestPopup: async <Result extends { authorizationUrl?: string }>(
      start: () => Promise<Result>,
    ) => start(),
  };
});

const page2Provider: PlatformIdentityProviderDraft = {
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
  clientId: 'client-page-2',
  dingtalkAllowedCorps: [],
  displayName: 'Page 2 Provider',
  domainAllowlist: ['example.test'],
  enabled: true,
  groupRoleMapping: {},
  icon: null,
  id: 'idp-page-2',
  issuer: 'https://idp.example.test/',
  migrationRequired: false,
  providerKey: 'page2-oidc',
  revision: 4,
  scopes: ['openid', 'profile', 'email'],
  secret: { configured: true, updatedAt: new Date('2026-01-01T00:00:00.000Z') },
  status: 'draft',
  type: 'generic_oidc',
  usePkce: true,
};

describe('IdentityProviderWizardModal revision retention (identity/F8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.update.mockResolvedValue({ ...page2Provider, revision: 5 });
    serviceMocks.testStart.mockResolvedValue({
      attemptId: 'attempt-1',
      authorizationUrl: 'https://idp.example.test/authorize',
    });
    serviceMocks.publish.mockResolvedValue({
      ...page2Provider,
      revision: 6,
      status: 'published',
    });
  });

  it('uses retained mutation revision 5 for real wizard test and publish after page-2 save', async () => {
    const dirtyRef = { current: false };
    const onChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <IdentityProviderWizardModalContent
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        dirtyRef={dirtyRef}
        provider={page2Provider}
        onChanged={onChanged}
      />,
    );

    expect(screen.getByTestId('identity-provider-wizard')).toBeTruthy();

    // Real wizard save action (openReasonModal auto-submits).
    await act(async () => {
      fireEvent.click(screen.getByText('identityProviders.actions.save'));
    });

    await waitFor(() => {
      expect(serviceMocks.update).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 4, id: 'idp-page-2' }),
      );
    });
    expect(onChanged).toHaveBeenCalled();

    // Navigate to publish step so test + publish actions are available.
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.publish/));
    });
    await waitFor(() => {
      expect(screen.getByTestId('step-publish')).toBeTruthy();
    });

    // Real startTest path: expectedRevision must be retained 5, not open prop 4.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-start-test'));
    });
    await waitFor(() => {
      expect(serviceMocks.testStart).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 5, id: 'idp-page-2' }),
      );
    });

    // Real publish path after save retention (4→5).
    await act(async () => {
      fireEvent.click(screen.getByText('identityProviders.actions.publish'));
    });
    await waitFor(() => {
      expect(serviceMocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 5, id: 'idp-page-2' }),
      );
    });
  });
});
