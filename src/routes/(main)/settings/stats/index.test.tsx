// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_GLOBAL_STATS_SCOPE,
  personalStatsDataSource,
  type StatsDataSource,
} from '@/features/SettingsStats';

import StatsSetting from './index';

const mocks = vi.hoisted(() => ({
  findAndGroupByDay: vi.fn(),
  rankUsers: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en-US' }, t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  FormGroup: ({
    children,
    extra,
    title,
  }: {
    children?: ReactNode;
    extra?: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      <header>{title}</header>
      <div>{extra}</div>
      {children}
    </section>
  ),
  Grid: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
}));

vi.mock('@lobehub/ui/base-ui', () => ({ Tabs: () => <div data-testid="group-by" /> }));
vi.mock('@lobehub/ui/icons', () => ({ ProviderIcon: () => null }));

vi.mock('antd', () => ({
  DatePicker: ({ picker }: { picker?: string }) => <div data-testid={`date-picker-${picker}`} />,
  Divider: () => null,
}));

vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@/routes/(main)/settings/features/SettingHeader', () => ({ default: () => null }));

vi.mock('./features/overview', () => ({
  ShareButton: () => <div data-testid="share-button" />,
  TotalAssistants: () => null,
  TotalMessages: () => null,
  TotalTokens: () => null,
  TotalTopics: () => null,
  Welcome: () => <div data-testid="welcome" />,
}));

vi.mock('./features/rankings', () => ({
  AssistantsRank: () => null,
  ModelsRank: () => null,
  TopicsRank: () => null,
  UsersRank: () => <div data-testid="users-rank" />,
}));

vi.mock('./features/usage', () => ({
  UsageCards: () => null,
  UsageTable: () => null,
  UsageTrends: () => null,
}));

vi.mock('./features/visualization', () => ({ AiHeatmaps: () => null }));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (_key: unknown, fetcher: () => Promise<unknown>) => {
    void fetcher();
    return { data: undefined, error: undefined, isLoading: true, mutate: vi.fn() };
  },
}));

const RANGE = {
  endAt: '2026-07-22T15:30:00.000Z',
  label: 'Last 7 days',
  startAt: '2026-07-16T00:00:00.000Z',
};

const adminSource: StatsDataSource = {
  ...personalStatsDataSource,
  findAndGroupByDay: mocks.findAndGroupByDay,
  rankUsers: mocks.rankUsers,
  scopeKey: ADMIN_GLOBAL_STATS_SCOPE,
};

describe('StatsSetting', () => {
  beforeEach(() => {
    mocks.findAndGroupByDay.mockReset().mockResolvedValue([]);
    mocks.rankUsers.mockReset().mockResolvedValue([]);
  });

  it('keepsThePersonalPageOnItsMonthPickerAndShareButton', () => {
    render(<StatsSetting />);

    expect(screen.getByTestId('date-picker-month')).toBeTruthy();
    expect(screen.getByTestId('share-button')).toBeTruthy();
    expect(screen.getByTestId('welcome')).toBeTruthy();
    expect(screen.queryByTestId('users-rank')).toBeNull();
  });

  it('replacesTheMonthPickerWithTheCallersFilterBarAndQueriesTheWindow', () => {
    render(
      <StatsSetting
        dataSource={adminSource}
        headerExtra={<div data-testid="user-filter" />}
        headerNode={<div data-testid="banner" />}
        range={RANGE}
      />,
    );

    expect(screen.queryByTestId('date-picker-month')).toBeNull();
    // The group-by tabs stay — only the window control moved to the page header.
    expect(screen.getByTestId('group-by')).toBeTruthy();
    expect(screen.getByTestId('user-filter')).toBeTruthy();
    expect(screen.queryByTestId('share-button')).toBeNull();
    expect(screen.getByTestId('users-rank')).toBeTruthy();
    expect(mocks.findAndGroupByDay).toHaveBeenCalledWith({
      endAt: RANGE.endAt,
      startAt: RANGE.startAt,
      userId: undefined,
    });
  });

  it('keepsTheUserRankingWhenThePageIsPinnedToOneUser', () => {
    render(
      <StatsSetting
        dataSource={adminSource}
        headerNode={<div data-testid="banner" />}
        range={RANGE}
        userId={'u1'}
      />,
    );

    // The card honours the same filter (it shows that user's row), so removing it would
    // only make the page lose a metric when a user is selected.
    expect(screen.getByTestId('users-rank')).toBeTruthy();
    expect(mocks.findAndGroupByDay).toHaveBeenCalledWith({
      endAt: RANGE.endAt,
      startAt: RANGE.startAt,
      userId: 'u1',
    });
  });
});
