// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RankCards from './RankCards';

const mocks = vi.hoisted(() => ({
  agents: {
    data: undefined as
      Array<{ avatar?: string; count: number; id: string; title?: string }> | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  models: {
    data: undefined as Array<{ count: number; id: string }> | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  users: {
    byMetric: undefined as Record<string, UserRankRow[]> | undefined,
    data: undefined as UserRankRow[] | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
    orderBy: 'totalTokens',
  },
}));

interface UserRankRow {
  avatar: string | null;
  cost: number;
  inputTokens: number;
  messages: number;
  name: string;
  outputTokens: number;
  totalTokens: number;
  userId: string;
}

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/charts', () => ({
  BarList: ({ data }: { data?: Array<{ key?: string; id?: string; name: string }> }) => (
    <div data-testid="bar-list">
      {(data ?? []).map((item) => (
        <span key={item.key ?? item.id}>{item.name}</span>
      ))}
    </div>
  ),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => null,
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({
    action,
    message,
    type,
  }: {
    action?: ReactNode;
    message?: ReactNode;
    type?: string;
  }) => (
    <div data-testid={`alert-${type}`}>
      <span>{message}</span>
      {action}
    </div>
  ),
  Avatar: () => null,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Segmented: ({
    onChange,
    options,
  }: {
    onChange?: (value: string) => void;
    options?: Array<{ label: ReactNode; value: string }>;
  }) => (
    <div>
      {(options ?? []).map((option) => (
        <button key={option.value} type="button" onClick={() => onChange?.(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./useOverviewStats', () => ({
  useOverviewAgentRank: () => mocks.agents,
  useOverviewModelRank: () => mocks.models,
  // Mirrors the real hook: the metric is a request parameter, so each metric has its own
  // server-ranked top-N rather than a re-sort of one fetched page.
  useOverviewUserRank: (_range: unknown, orderBy: string = 'totalTokens') => {
    mocks.users.orderBy = orderBy;
    return { ...mocks.users, data: mocks.users.byMetric?.[orderBy] ?? mocks.users.data };
  },
}));

describe('AdminOverviewRankCards', () => {
  beforeEach(() => {
    for (const entry of [mocks.models, mocks.agents, mocks.users]) {
      entry.data = undefined;
      entry.error = undefined;
      entry.isLoading = false;
      entry.mutate.mockReset();
    }
    mocks.users.byMetric = undefined;
    mocks.users.orderBy = 'totalTokens';
  });

  it('rendersRetryableErrorOnInitialFailure', () => {
    mocks.models.error = new Error('denied');
    mocks.agents.error = new Error('denied');
    mocks.users.error = new Error('denied');
    render(<RankCards />);
    expect(screen.getAllByTestId('alert-error')).toHaveLength(3);
    fireEvent.click(screen.getAllByRole('button', { name: 'overview.error.retry' })[0]!);
    expect(mocks.models.mutate).toHaveBeenCalled();
  });

  it('preservesEmptyStateWithRefreshWarningOnStaleEmptyRefreshFailure', () => {
    mocks.models.data = [];
    mocks.models.error = new Error('refresh failed');
    mocks.agents.data = [{ count: 0, id: 'a', title: 'Agent' }];
    mocks.agents.error = new Error('refresh failed');
    render(<RankCards />);
    expect(screen.getAllByTestId('alert-warning')).toHaveLength(2);
    expect(screen.getAllByText('overview.rank.emptyTitle')).toHaveLength(3);
    expect(screen.queryByTestId('bar-list')).toBeNull();
  });

  it('labelsModelsWithTheirCardNameAndKeepsUnknownIdsVerbatim', () => {
    mocks.models.data = [
      { count: 5, id: 'gpt-5.6-luna' },
      { count: 1, id: 'some-self-hosted-model' },
    ];
    mocks.agents.data = [];
    render(<RankCards />);
    expect(screen.getByText('GPT-5.6 Luna')).toBeInTheDocument();
    expect(screen.getByText('some-self-hosted-model')).toBeInTheDocument();
  });

  it('keepsStaleRankDataWithRefreshWarning', () => {
    mocks.models.data = [{ count: 3, id: 'gpt' }];
    mocks.models.error = new Error('refresh failed');
    mocks.agents.data = [{ count: 2, id: 'a', title: 'Agent' }];
    mocks.agents.error = undefined;
    render(<RankCards />);
    expect(screen.getByTestId('alert-warning')).toHaveTextContent('overview.error.refreshFailed');
    expect(screen.getAllByTestId('bar-list')).toHaveLength(2);
  });

  it('refetchesTheUserRankPerMetricSoTheTrueLeaderIsNotHiddenByTheTokenTopFive', () => {
    const row = (name: string, values: Partial<UserRankRow>): UserRankRow => ({
      avatar: null,
      cost: 0,
      inputTokens: 0,
      messages: 0,
      name,
      outputTokens: 0,
      totalTokens: 0,
      userId: name,
      ...values,
    });
    // "Chatty" leads on messages but is nowhere near the token top-5, so it is simply
    // absent from the totalTokens page the server returns.
    mocks.users.byMetric = {
      messages: [row('Chatty', { messages: 400 }), row('Heavy tokens', { messages: 2 })],
      totalTokens: [row('Heavy tokens', { totalTokens: 100 })],
    };

    render(<RankCards />);
    const userRows = () => screen.getAllByTestId('bar-list').at(-1)!.textContent ?? '';

    expect(mocks.users.orderBy).toBe('totalTokens');
    expect(userRows()).not.toContain('Chatty');

    fireEvent.click(screen.getByRole('button', { name: 'overview.rank.usersMetricMessages' }));

    // The switch asks the server for that metric's top-N instead of re-sorting the five
    // rows already on screen — otherwise the real leader could never appear.
    expect(mocks.users.orderBy).toBe('messages');
    expect(userRows().indexOf('Chatty')).toBeLessThan(userRows().indexOf('Heavy tokens'));
  });
});
