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
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
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
  keyManagement: {
    errorCategory: null,
    keyId: 'env:default',
    masterKeyConfigured: true,
    provider: 'env',
    status: 'unknown',
    vaultAddress: null,
  },
  mail: {
    errorCategory: null,
    fromAddress: 'noreply@example.com',
    host: 'smtp.example.com',
    port: 587,
    provider: 'smtp',
    secure: true,
    senderName: 'Platform',
    status: 'unknown',
  },
  objectStorage: {
    accessId: 'AKIA****MPLE',
    bucket: 'files',
    endpoint: 'https://s3.example.com',
    errorCategory: null,
    pathStyle: true,
    publicDomain: null,
    region: 'us-east-1',
    status: 'unknown',
  },
  snapshotAt: new Date('2026-08-17T00:00:00.000Z'),
});

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
});
