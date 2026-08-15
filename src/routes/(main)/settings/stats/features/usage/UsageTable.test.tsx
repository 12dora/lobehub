// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import {
  ADMIN_GLOBAL_STATS_SCOPE,
  personalStatsDataSource,
  type StatsDataSource,
  StatsDataSourceProvider,
  type StatsFilter,
  StatsFilterProvider,
} from '@/features/SettingsStats';

import UsageTable from './UsageTable';

vi.mock('antd-style', () => ({ cssVar: {} }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/icons', () => ({ ProviderIcon: () => null }));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/InlineTable', () => ({
  default: ({ pagination }: { pagination?: { current?: number } }) => (
    <div data-current={pagination?.current} data-testid="table" />
  ),
}));

vi.mock('@/utils/modelLabels', () => ({
  getModelDisplayName: (model: string) => model,
  useProviderLabel: () => (provider: string) => provider,
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: () => ({ data: [], error: undefined, isLoading: false, mutate: vi.fn() }),
}));

const adminSource: StatsDataSource = {
  ...personalStatsDataSource,
  scopeKey: ADMIN_GLOBAL_STATS_SCOPE,
};

const FIRST: StatsFilter = {
  endAt: '2026-07-22T00:00:00.000Z',
  startAt: '2026-06-22T00:00:00.000Z',
};
const SECOND: StatsFilter = { ...FIRST, startAt: '2026-05-22T00:00:00.000Z' };

const AdminHarness = () => {
  const [filter, setFilter] = useState<StatsFilter>(FIRST);
  return (
    <StatsDataSourceProvider value={adminSource}>
      <StatsFilterProvider value={filter}>
        <UsageTable />
        <button type="button" onClick={() => setFilter(SECOND)}>
          widen
        </button>
        <button type="button" onClick={() => setFilter({ ...filter, userId: 'u1' })}>
          pin-user
        </button>
        <span data-testid="search">{useLocation().search}</span>
      </StatsFilterProvider>
    </StatsDataSourceProvider>
  );
};

const page = () => screen.getByTestId('table').dataset.current;

describe('UsageTable pagination against an active filter', () => {
  it('resetsToTheFirstPageWhenTheWindowChanges', () => {
    render(
      <MemoryRouter initialEntries={['/admin/stats?current=3']}>
        <AdminHarness />
      </MemoryRouter>,
    );
    expect(page()).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: 'widen' }));

    // The new window has its own row count — page 3 of the old one is usually blank.
    expect(page()).toBe('1');
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('resetsToTheFirstPageWhenTheSelectedUserChanges', () => {
    render(
      <MemoryRouter initialEntries={['/admin/stats?current=4']}>
        <AdminHarness />
      </MemoryRouter>,
    );
    expect(page()).toBe('4');

    fireEvent.click(screen.getByRole('button', { name: 'pin-user' }));
    expect(page()).toBe('1');
  });

  it('leavesThePersonalPageUrlAloneWhenThereIsNoFilter', () => {
    render(
      <MemoryRouter initialEntries={['/settings/stats?current=3']}>
        <UsageTable />
      </MemoryRouter>,
    );

    // No filter can change here, so the deep-linked page survives untouched.
    expect(page()).toBe('3');
  });
});
