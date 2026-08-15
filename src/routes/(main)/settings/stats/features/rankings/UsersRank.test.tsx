// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_GLOBAL_STATS_SCOPE,
  personalStatsDataSource,
  type StatsDataSource,
  StatsDataSourceProvider,
  StatsFilterProvider,
} from '@/features/SettingsStats';

import UsersRank from './UsersRank';

const mocks = vi.hoisted(() => ({
  key: undefined as unknown,
  rankUsers: vi.fn(),
}));

vi.mock('antd-style', () => ({ cssVar: {} }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/charts', () => ({
  BarList: ({ data }: { data?: Array<{ key?: string; name: string }> }) => (
    <div data-testid="bar-list">
      {(data ?? []).map((item) => (
        <span key={item.key}>{item.name}</span>
      ))}
    </div>
  ),
}));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: () => null,
  Avatar: () => null,
}));

vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ImperativeModal', () => ({
  default: () => null,
}));

vi.mock('../components/StatsFormGroup', () => ({
  default: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>) => {
    mocks.key = key;
    if (key !== null) void fetcher();
    return { data: undefined, error: undefined, isLoading: key !== null, mutate: vi.fn() };
  },
}));

const RANGE = {
  endAt: '2026-07-22T15:30:00.000Z',
  startAt: '2026-07-16T00:00:00.000Z',
};

const adminSource: StatsDataSource = {
  ...personalStatsDataSource,
  rankUsers: mocks.rankUsers,
  scopeKey: ADMIN_GLOBAL_STATS_SCOPE,
};

describe('UsersRank', () => {
  beforeEach(() => {
    mocks.key = undefined;
    mocks.rankUsers.mockReset().mockResolvedValue([]);
  });

  it('makesNoRequestWhenTheDataSourceHasNoUserRanking', () => {
    render(<UsersRank />);
    expect(mocks.key).toBeNull();
    expect(mocks.rankUsers).not.toHaveBeenCalled();
  });

  it('requestsTheSelectedWindow', () => {
    render(
      <StatsDataSourceProvider value={adminSource}>
        <StatsFilterProvider value={RANGE}>
          <UsersRank />
        </StatsFilterProvider>
      </StatsDataSourceProvider>,
    );

    expect(screen.getByTestId('bar-list')).toBeTruthy();
    expect(mocks.rankUsers).toHaveBeenCalledWith(undefined, { ...RANGE, userId: undefined });
    expect(mocks.key).toEqual(
      expect.arrayContaining([ADMIN_GLOBAL_STATS_SCOPE, RANGE.startAt, RANGE.endAt]),
    );
  });

  it('passesThePinnedUserThroughSoTheCardMatchesTheRestOfThePage', () => {
    render(
      <StatsDataSourceProvider value={adminSource}>
        <StatsFilterProvider value={{ ...RANGE, userId: 'u1' }}>
          <UsersRank />
        </StatsFilterProvider>
      </StatsDataSourceProvider>,
    );

    // Dropping the userId here would rank the whole platform next to figures that are
    // scoped to one user — the server narrows the ranking to that user's row instead.
    expect(mocks.rankUsers).toHaveBeenCalledWith(undefined, { ...RANGE, userId: 'u1' });
    expect(mocks.key).toEqual(expect.arrayContaining(['u1']));
  });
});
