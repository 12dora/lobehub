// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { AdminSystemSandboxSettings } from '@/enterprise/client/services/adminSystem';

import { SandboxCard } from './SandboxCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  // Rendered only while open, exactly as base-ui does — so "behind 详情" is a real assertion.
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
  Segmented: ({
    onChange,
    options,
    value,
  }: {
    onChange?: (next: string) => void;
    options?: Array<{ label: string; value: string }>;
    value?: string;
  }) => (
    <select value={value} onChange={(event) => onChange?.(event.target.value)}>
      {(options ?? []).map((entry) => (
        <option key={entry.value} value={entry.value}>
          {entry.label}
        </option>
      ))}
    </select>
  ),
  Select: ({
    onChange,
    options,
    value,
  }: {
    onChange?: (next: string) => void;
    options?: Array<{ label: string; value: string }>;
    value?: string;
  }) => (
    <select value={value} onChange={(event) => onChange?.(event.target.value)}>
      {(options ?? []).map((entry) => (
        <option key={entry.value} value={entry.value}>
          {entry.label}
        </option>
      ))}
    </select>
  ),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'password', permissions: [] }),
}));

vi.mock('../../primitives/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: () => undefined,
}));

vi.mock('./invalidate', () => ({
  invalidateAdminSandboxSettings: () => Promise.resolve(),
}));

/** Exercised on its own in SandboxPackageStats.test.tsx; here only its placement matters. */
vi.mock('./SandboxPackageStats', () => ({
  SandboxPackageStats: () => <div data-testid="sandbox-package-stats" />,
}));

const view = (overrides: Partial<AdminSystemSandboxSettings> = {}): AdminSystemSandboxSettings => ({
  cpus: 1,
  dockerHost: null,
  dockerSocket: '/var/run/docker.sock',
  enabled: false,
  idleTtlSec: 1800,
  image: 'aihub-sandbox:latest',
  maxContainers: 8,
  maxOutputBytes: 1_048_576,
  memoryMb: 1024,
  moduleEnabled: true,
  network: 'bridge',
  pidsLimit: 256,
  provider: 'local',
  pullPolicy: 'if-missing',
  revision: 0,
  source: 'env',
  timeoutMs: 120_000,
  ...overrides,
});

const renderCard = (ui: ReactNode) => {
  const router = createMemoryRouter([{ element: ui, path: '/' }], { initialEntries: ['/'] });
  return render(<RouterProvider router={router} />);
};

describe('SandboxCard', () => {
  it('shows a modules-page hint when the sandbox module is disabled', () => {
    renderCard(<SandboxCard canOperate moduleEnabled={false} view={view()} />);
    expect(screen.getByText('systemGeneral.sandbox.moduleDisabled')).toBeTruthy();
    expect(screen.getByText('systemGeneral.sandbox.openModules')).toBeTruthy();
    expect(screen.queryByText('systemGeneral.card.edit')).toBeNull();
  });

  it('summarises five local fields and keeps the remaining limits in 详情', () => {
    renderCard(
      <SandboxCard
        canOperate
        moduleEnabled
        view={view()}
        service={{
          getSandboxPackageStats: vi.fn(),
          getSandboxSettings: vi.fn(),
          updateSandboxSettings: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText('systemGeneral.sandbox.fields.image')).toBeTruthy();
    expect(screen.queryByText('systemGeneral.sandbox.fields.maxContainers')).toBeNull();

    fireEvent.click(screen.getByText('systemGeneral.card.details'));

    expect(screen.getByText('systemGeneral.sandbox.fields.maxContainers')).toBeTruthy();
    expect(screen.getByText('SANDBOX_PROVIDER')).toBeTruthy();
  });

  it('saves an override from inside the 编辑 modal', async () => {
    const updateSandboxSettings = vi
      .fn()
      .mockResolvedValue(view({ enabled: true, revision: 1, source: 'db' }));
    renderCard(
      <SandboxCard
        canOperate
        moduleEnabled
        view={view()}
        service={{
          getSandboxPackageStats: vi.fn(),
          getSandboxSettings: vi.fn(),
          updateSandboxSettings,
        }}
      />,
    );

    expect(screen.queryByText('systemGeneral.edit.save')).toBeNull();
    fireEvent.click(screen.getByText('systemGeneral.card.edit'));
    fireEvent.click(screen.getByText('systemGeneral.edit.save'));

    expect(updateSandboxSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          enabled: true,
          image: 'aihub-sandbox:latest',
          provider: 'local',
        }),
        expectedRevision: 0,
      }),
    );
  });

  /** The ledger is evidence for the next image build, not a card reading — it lives in 详情. */
  it('shows the package ledger in 详情 rather than on the card', () => {
    renderCard(
      <SandboxCard
        canOperate
        moduleEnabled
        view={view()}
        service={{
          getSandboxPackageStats: vi.fn(),
          getSandboxSettings: vi.fn(),
          updateSandboxSettings: vi.fn(),
        }}
      />,
    );

    expect(screen.queryByTestId('sandbox-package-stats')).toBeNull();

    fireEvent.click(screen.getByText('systemGeneral.card.details'));

    expect(screen.getByTestId('sandbox-package-stats')).toBeTruthy();
  });

  it('does not render the ledger — or a 详情 door onto nothing — when the module is off', () => {
    renderCard(<SandboxCard canOperate moduleEnabled={false} view={view()} />);
    expect(screen.queryByTestId('sandbox-package-stats')).toBeNull();
    expect(screen.queryByText('systemGeneral.card.details')).toBeNull();
  });
});
