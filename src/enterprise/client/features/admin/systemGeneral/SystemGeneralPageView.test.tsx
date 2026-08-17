// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { AdminSystemInfraSettings } from '@/enterprise/client/services/adminSystem';

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
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
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
  Input: (props: Record<string, unknown>) => <input {...props} />,
  InputPassword: (props: Record<string, unknown>) => <input type="password" {...props} />,
  Segmented: () => <span />,
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

describe('SystemGeneralPageView', () => {
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
    expect(screen.getAllByText('systemGeneral.edit.switchToDb')).toHaveLength(2);
    // Read-only rows, not a form.
    expect(screen.queryByDisplayValue('files')).toBeNull();
  });

  it('shows the editable form for a dependency that is already managed here', () => {
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
    expect(screen.getByDisplayValue('files')).toBeTruthy();
    expect(screen.getByText('systemGeneral.edit.save')).toBeTruthy();
    expect(screen.getByText('systemGeneral.edit.revert')).toBeTruthy();
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
