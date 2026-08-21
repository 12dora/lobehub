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

vi.mock('../InfraSettingsCard', () => ({
  InfraSettingsCard: ({
    editor,
    extraActions,
    fields,
    notice,
    title,
  }: {
    editor?: ReactNode;
    extraActions?: ReactNode;
    fields?: Array<{ label: string; value: ReactNode }>;
    notice?: ReactNode;
    title: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {notice}
      {editor ??
        fields?.map((field) => (
          <div key={field.label}>
            {field.label}: {field.value}
          </div>
        ))}
      {extraActions}
    </section>
  ),
}));

vi.mock('../../primitives/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: () => undefined,
}));

vi.mock('./invalidate', () => ({
  invalidateAdminSandboxSettings: () => Promise.resolve(),
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
    expect(screen.queryByText('systemGeneral.edit.switchToDb')).toBeNull();
  });

  it('renders local fields and saves an override', async () => {
    const updateSandboxSettings = vi
      .fn()
      .mockResolvedValue(view({ enabled: true, revision: 1, source: 'db' }));
    renderCard(
      <SandboxCard
        canOperate
        moduleEnabled
        service={{ getSandboxSettings: vi.fn(), updateSandboxSettings }}
        view={view()}
      />,
    );

    expect(screen.getByText(/systemGeneral.sandbox.fields.image/)).toBeTruthy();
    fireEvent.click(screen.getByText('systemGeneral.edit.switchToDb'));
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
});
