// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { describe, expect, it, vi } from 'vitest';

import type { AdminSystemSandboxPackageStats } from '@/enterprise/client/services/adminSystem';

import { SandboxPackageStats } from './SandboxPackageStats';

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
  Alert: ({ action, message }: { action?: ReactNode; message?: ReactNode }) => (
    <div role="alert">
      {message}
      {action}
    </div>
  ),
  Skeleton: ({ active }: { active?: boolean }) => (
    <div data-active={String(active)} data-testid="skeleton" />
  ),
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
}));

const stats = (
  overrides: Partial<AdminSystemSandboxPackageStats> = {},
): AdminSystemSandboxPackageStats => ({
  generatedAt: new Date('2026-08-23T12:00:00.000Z'),
  items: [
    {
      installs: 12,
      lastInstalledAt: new Date('2026-08-23T11:30:00.000Z'),
      manager: 'pip',
      package: 'pandas',
      preinstalled: true,
      users: 4,
    },
    {
      installs: 3,
      lastInstalledAt: new Date('2026-08-23T10:00:00.000Z'),
      manager: 'npm',
      package: 'zx',
      preinstalled: false,
      users: 2,
    },
  ],
  preinstalled: ['pandas', 'numpy'],
  totalPackages: 2,
  windowDays: 30,
  ...overrides,
});

/** A fresh cache per render, so one test's window never answers the next test's first fetch. */
const renderStats = (getSandboxPackageStats: ReturnType<typeof vi.fn>) =>
  render(
    <SWRConfig value={{ dedupingInterval: 0, errorRetryCount: 0, provider: () => new Map() }}>
      <SandboxPackageStats
        service={{
          getSandboxPackageStats,
          getSandboxSettings: vi.fn(),
          updateSandboxSettings: vi.fn(),
        }}
      />
    </SWRConfig>,
  );

describe('SandboxPackageStats', () => {
  it('asks for the default 30-day window and labels preinstalled vs candidate packages', async () => {
    const getSandboxPackageStats = vi.fn().mockResolvedValue(stats());
    renderStats(getSandboxPackageStats);

    expect(getSandboxPackageStats).toHaveBeenCalledWith({ days: 30, limit: 20 });

    expect(await screen.findByText('pandas')).toBeTruthy();
    expect(screen.getByText('zx')).toBeTruthy();
    expect(screen.getByText('pip')).toBeTruthy();
    expect(screen.getByText('npm')).toBeTruthy();
    expect(screen.getByText('systemGeneral.sandbox.packages.status.preinstalled')).toBeTruthy();
    expect(screen.getByText('systemGeneral.sandbox.packages.status.candidate')).toBeTruthy();
    expect(
      screen.getByText(
        'systemGeneral.sandbox.packages.summary:{"days":30,"preinstalled":2,"total":2}',
      ),
    ).toBeTruthy();
    expect(screen.getByText('systemGeneral.sandbox.packages.hint')).toBeTruthy();
    // The ledger scrolls inside its own box and says how much of it is on screen.
    expect(screen.getByText('systemGeneral.card.showingLatest:{"count":2}')).toBeTruthy();
  });

  it('re-queries with the selected window', async () => {
    const getSandboxPackageStats = vi.fn().mockResolvedValue(stats());
    renderStats(getSandboxPackageStats);
    await screen.findByText('pandas');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '7' } });

    await waitFor(() =>
      expect(getSandboxPackageStats).toHaveBeenCalledWith({ days: 7, limit: 20 }),
    );
  });

  it('states that nothing has been installed yet instead of showing an empty table', async () => {
    const getSandboxPackageStats = vi
      .fn()
      .mockResolvedValue(stats({ items: [], preinstalled: [], totalPackages: 0 }));
    renderStats(getSandboxPackageStats);

    expect(await screen.findByText('systemGeneral.sandbox.packages.empty')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('offers a retry when the ledger cannot be read', async () => {
    const getSandboxPackageStats = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(stats());
    renderStats(getSandboxPackageStats);

    const retry = await screen.findByText('systemGeneral.sandbox.packages.retry');
    fireEvent.click(retry);

    expect(await screen.findByText('pandas')).toBeTruthy();
  });
});
