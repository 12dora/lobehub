// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminBrowserProfileSummary,
  AdminSystemInfraSettings,
} from '@/enterprise/client/services/adminSystem';

import { SystemGeneralPageView } from './SystemGeneralPageView';

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, message }: { action?: ReactNode; message?: ReactNode }) => (
    <div data-testid="alert">
      <span>{message}</span>
      {action}
    </div>
  ),
  // The fingerprint card renders one next to the installation id whenever it HAS a profile.
  CopyButton: ({ content }: { content: string }) => (
    <button data-copy={content} type="button">
      copy
    </button>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
  Skeleton: () => <div data-testid="skeleton" />,
  Tag: ({ children }: { children?: ReactNode }) => <span data-testid="status-tag">{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal: vi.fn(),
  Input: (props: Record<string, unknown>) => <input {...props} />,
  InputPassword: (props: Record<string, unknown>) => <input type="password" {...props} />,
  // The card's two secondary surfaces: rendered only while open, exactly as base-ui does.
  Modal: ({
    children,
    footer,
    open,
    title,
  }: {
    children?: ReactNode;
    footer?: ReactNode;
    open?: boolean;
    title?: ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        <h3>{title}</h3>
        {children}
        {footer}
      </div>
    ) : null,
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Segmented: () => <span />,
  Select: () => <span />,
  Switch: () => <span />,
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The editable cards reach for admin plumbing the page view itself does not need.
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'password', permissions: [] }),
}));

vi.mock('./infra/service', () => ({ infraSettingsMutationService: {} }));

vi.mock('./infra/invalidate', () => ({
  invalidateAdminInfraSettings: () => Promise.resolve(),
}));

vi.mock('@/enterprise/client/features/admin/primitives/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: () => undefined,
}));

vi.mock('@/enterprise/client/features/admin/pages/AdminStateSurfaces', () => ({
  AdminLoadingSurface: () => <div>loading</div>,
}));

vi.mock('@/enterprise/client/features/admin/primitives/AdminPageTemplate', () => ({
  default: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

const settings = (): AdminSystemInfraSettings => ({
  mail: {
    enabled: false,
    errorCategory: null,
    fromAddress: 'noreply@example.com',
    hasResendApiKey: false,
    hasSmtpPass: true,
    host: 'smtp.example.com',
    port: 587,
    provider: 'smtp',
    revision: 0,
    secure: true,
    senderName: 'Platform',
    smtpUser: 'mailer',
    source: 'env',
    status: 'unknown',
  },
  objectStorage: {
    accessId: 'AKIA****MPLE',
    bucket: 'files',
    enabled: false,
    endpoint: 'https://s3.example.com',
    errorCategory: null,
    hasSecretAccessKey: true,
    pathStyle: true,
    previewUrlExpireIn: null,
    publicDomain: null,
    region: 'us-east-1',
    revision: 0,
    setAcl: false,
    source: 'env',
    status: 'unknown',
  },
  snapshotAt: new Date('2026-08-17T00:00:00.000Z'),
});

/** Object storage taken over from the environment; mail still environment-sourced. */
const managedHere = (): AdminSystemInfraSettings => {
  const base = settings();
  return {
    ...base,
    objectStorage: {
      ...base.objectStorage,
      accessId: 'AKIAFULLVALUE',
      enabled: true,
      revision: 2,
      source: 'db',
    },
  };
};

const browserProfile = (): AdminBrowserProfileSummary => ({
  arch: 'arm',
  chromeVersion: '150.0.7871.95',
  cores: 12,
  createdAt: new Date('2026-08-18T00:00:00.000Z'),
  impersonateProfile: 'chrome150',
  installationId: '123e4567-e89b-42d3-a456-426614174000',
  locale: 'en-US',
  memoryGiB: 36,
  platform: 'macOS',
  platformVersion: '15.6.1',
  revision: 3,
  screen: { dpr: 2, height: 982, width: 1512 },
  chromeId: 'chrome-150',
  computeId: 'compute-mac-arm-12-24',
  localeId: 'locale-en-us-new-york',
  screenId: 'screen-mac-1512-982-2',
  systemId: 'system-macos-15-arm',
  webglId: 'webgl-apple-m3',
  timezone: 'America/New_York',
  updatedAt: new Date('2026-08-18T01:00:00.000Z'),
});

describe('SystemGeneralPageView', () => {
  it('shows ONE page state while the infrastructure settings are still loading', () => {
    // The grid used to render unconditionally, which put the fingerprint card — with an enabled
    // destructive action — underneath a full-viewport "checking permissions" surface.
    render(
      <SystemGeneralPageView
        canOperate
        isLoading
        profileIsLoading
        data={undefined}
        error={undefined}
        probeBusy={{}}
        probeResults={{}}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.queryByText('browserProfile.title')).toBeNull();
    expect(screen.queryByText('systemGeneral.objectStorage.title')).toBeNull();
  });

  it('speaks with one voice when the page fails to load', () => {
    // Two alerts for the same failure, each with its own 重试 of a different weight, left the
    // operator guessing which one to press.
    render(
      <SystemGeneralPageView
        canOperate
        error={new Error('denied')}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        profileError={new Error('denied')}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('systemGeneral.loadFailed')).toBeTruthy();
    expect(screen.queryByText('browserProfile.states.error')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'systemGeneral.retry' })).toHaveLength(1);
  });

  it('keeps the fingerprint card when only the settings request failed', () => {
    // The two requests are independent: an object-storage/mail outage used to delete a
    // fingerprint that had loaded perfectly well, along with the only way to regenerate it.
    render(
      <SystemGeneralPageView
        canOperate
        error={new Error('denied')}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        profileData={browserProfile()}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('systemGeneral.loadFailed')).toBeTruthy();
    expect(screen.getByText('browserProfile.title')).toBeTruthy();
    expect(screen.getByText('browserProfile.actions.regenerate')).toBeTruthy();
    // Still one page state for the request that actually failed.
    expect(screen.getAllByRole('button', { name: 'systemGeneral.retry' })).toHaveLength(1);
    expect(screen.queryByText('systemGeneral.objectStorage.title')).toBeNull();
    expect(screen.queryByText('systemGeneral.mail.title')).toBeNull();
  });

  it('keeps the fingerprint card owning its own failure while the settings load fine', () => {
    render(
      <SystemGeneralPageView
        canOperate
        data={settings()}
        error={undefined}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        profileError={new Error('offline')}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    expect(screen.queryByText('systemGeneral.loadFailed')).toBeNull();
    expect(screen.getByText('browserProfile.states.error')).toBeTruthy();
  });

  it('renders masked configuration and hides the probe when the operator cannot test', () => {
    render(
      <SystemGeneralPageView
        canOperate={false}
        data={settings()}
        error={undefined}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('AKIA****MPLE')).toBeTruthy();
    expect(screen.getByText('noreply@example.com')).toBeTruthy();
    expect(screen.queryByText('systemGeneral.testConnection')).toBeNull();
  });

  it('shows only the two configurable dependencies — the encryption key is not a card here', () => {
    render(
      <SystemGeneralPageView
        canOperate
        data={settings()}
        error={undefined}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('systemGeneral.objectStorage.title')).toBeTruthy();
    expect(screen.getByText('systemGeneral.mail.title')).toBeTruthy();
    expect(screen.queryByText('systemGeneral.keyManagement.title')).toBeNull();
  });

  it('runs a live probe from the object-storage card', () => {
    const onTest = vi.fn();
    render(
      <SystemGeneralPageView
        canOperate
        data={settings()}
        error={undefined}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        onRetry={vi.fn()}
        onTest={onTest}
      />,
    );

    fireEvent.click(screen.getAllByText('systemGeneral.testConnection')[0]!);
    expect(onTest).toHaveBeenCalledWith('objectStorage');
  });

  it('shows a retryable error when the overview fails to load', () => {
    const onRetry = vi.fn();
    render(
      <SystemGeneralPageView
        canOperate
        error={new Error('denied')}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        onRetry={onRetry}
        onTest={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'systemGeneral.retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('offers to take an environment-sourced dependency over', () => {
    render(
      <SystemGeneralPageView
        canOperate
        data={settings()}
        error={undefined}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    expect(screen.getAllByText('systemGeneral.source.env')).toHaveLength(2);
    expect(screen.getAllByText('systemGeneral.card.edit')).toHaveLength(2);
    // Read-only rows, not a form: the editor only exists inside the 编辑 modal.
    expect(screen.queryByDisplayValue('files')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the editor for a dependency that is already managed here in a modal', () => {
    render(
      <SystemGeneralPageView
        canOperate
        data={managedHere()}
        error={undefined}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('systemGeneral.source.db')).toBeTruthy();
    // The card stays a summary until 编辑 is pressed — that is what keeps the grid aligned.
    expect(screen.queryByDisplayValue('files')).toBeNull();

    fireEvent.click(screen.getAllByText('systemGeneral.card.edit')[0]!);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByDisplayValue('files')).toBeTruthy();
    expect(screen.getByText('systemGeneral.edit.save')).toBeTruthy();
    expect(screen.getByText('systemGeneral.edit.revert')).toBeTruthy();
  });

  it('keeps every field of a dependency reachable through 详情', () => {
    render(
      <SystemGeneralPageView
        canOperate
        data={settings()}
        error={undefined}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    // Path-style access is not one of the five summary rows…
    expect(screen.queryByText('systemGeneral.objectStorage.fields.pathStyle')).toBeNull();

    fireEvent.click(screen.getAllByText('systemGeneral.card.details')[0]!);

    // …but 详情 carries the complete list, plus the variables that drive it.
    expect(screen.getByText('systemGeneral.objectStorage.fields.pathStyle')).toBeTruthy();
    expect(screen.getByText('S3_ENDPOINT')).toBeTruthy();
  });

  it('warns when a saved override exists but is not the configuration in effect', () => {
    const base = settings();
    const failOpen: AdminSystemInfraSettings = {
      ...base,
      // The server could not decrypt/load the saved override and fell open to the environment.
      objectStorage: { ...base.objectStorage, enabled: true, revision: 3, source: 'env' },
    };

    render(
      <SystemGeneralPageView
        canOperate
        data={failOpen}
        error={undefined}
        isLoading={false}
        probeBusy={{}}
        probeResults={{}}
        onRetry={vi.fn()}
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('systemGeneral.failOpen.title')).toBeTruthy();
    // Mail is a normal environment card, so exactly one warning is shown.
    expect(screen.queryAllByText('systemGeneral.failOpen.title')).toHaveLength(1);
  });
});
