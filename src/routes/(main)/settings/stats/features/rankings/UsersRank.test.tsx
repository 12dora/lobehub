// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('antd-style', () => ({ createStaticStyles: () => ({}), cssVar: {} }));

vi.mock('@lobehub/ui/base-ui', () => ({
  Segmented: ({
    onChange,
    options,
    value,
  }: {
    onChange?: (value: string) => void;
    options: Array<{ label: string; value: string }>;
    value: string;
  }) => (
    <div data-testid="metric-switch" data-value={value}>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onChange?.(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

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
  default: ({
    children,
    extra,
    title,
  }: {
    children?: ReactNode;
    extra?: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <div>{extra}</div>
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
    expect(mocks.rankUsers).toHaveBeenCalledWith(undefined, {
      ...RANGE,
      orderBy: 'totalTokens',
      userId: undefined,
    });
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
    expect(mocks.rankUsers).toHaveBeenCalledWith(undefined, {
      ...RANGE,
      orderBy: 'totalTokens',
      userId: 'u1',
    });
    expect(mocks.key).toEqual(expect.arrayContaining(['u1']));
  });

  it('refetchesRankedByTheChosenMetricLikeTheOverviewCard', () => {
    render(
      <StatsDataSourceProvider value={adminSource}>
        <StatsFilterProvider value={RANGE}>
          <UsersRank />
        </StatsFilterProvider>
      </StatsDataSourceProvider>,
    );

    expect(screen.getByTestId('metric-switch').dataset.value).toBe('totalTokens');
    fireEvent.click(screen.getByText('stats.usersRank.metric.cost'));

    // The top five by cost are not the top five by tokens: the server re-ranks, and the
    // cache key carries the metric so the two rankings never overwrite each other.
    expect(screen.getByTestId('metric-switch').dataset.value).toBe('cost');
    expect(mocks.rankUsers).toHaveBeenLastCalledWith(undefined, {
      ...RANGE,
      orderBy: 'cost',
      userId: undefined,
    });
    expect(mocks.key).toEqual(expect.arrayContaining(['cost']));
  });
});
