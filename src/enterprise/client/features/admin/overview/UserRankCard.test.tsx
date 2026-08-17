// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UserRankCard from './UserRankCard';

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

const mocks = vi.hoisted(() => ({
  users: {
    byMetric: undefined as Record<string, UserRankRow[]> | undefined,
    data: undefined as UserRankRow[] | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
    orderBy: 'totalTokens',
  },
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/charts', () => ({
  BarList: ({ data }: { data?: Array<{ key?: string; id?: string; name: ReactNode }> }) => (
    <div data-testid="bar-list">
      {(data ?? []).map((item) => (
        <span key={item.key ?? item.id}>{item.name}</span>
      ))}
    </div>
  ),
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
  useOverviewUserRank: (_range: unknown, orderBy: string = 'totalTokens') => {
    mocks.users.orderBy = orderBy;
    return { ...mocks.users, data: mocks.users.byMetric?.[orderBy] ?? mocks.users.data };
  },
}));

const row = (name: string, values: Partial<UserRankRow> = {}): UserRankRow => ({
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

describe('AdminOverviewUserRankCard', () => {
  beforeEach(() => {
    mocks.users.data = undefined;
    mocks.users.byMetric = undefined;
    mocks.users.error = undefined;
    mocks.users.isLoading = false;
    mocks.users.orderBy = 'totalTokens';
    mocks.users.mutate.mockReset();
  });

  it('rendersRetryableErrorOnInitialFailure', () => {
    mocks.users.error = new Error('denied');
    render(<UserRankCard />);
    expect(screen.getByTestId('alert-error')).toHaveTextContent('overview.error.loadFailed');
    fireEvent.click(screen.getByRole('button', { name: 'overview.error.retry' }));
    expect(mocks.users.mutate).toHaveBeenCalled();
    expect(screen.queryByTestId('bar-list')).toBeNull();
  });

  it('keepsStaleRankDataWithRefreshWarning', () => {
    mocks.users.data = [row('Heavy tokens', { totalTokens: 100 })];
    mocks.users.error = new Error('refresh failed');
    render(<UserRankCard />);
    expect(screen.getByTestId('alert-warning')).toHaveTextContent('overview.error.refreshFailed');
    expect(screen.getByTestId('bar-list')).toHaveTextContent('Heavy tokens');
    expect(screen.queryByTestId('alert-error')).toBeNull();
  });

  it('refetchesTheUserRankPerMetricSoTheTrueLeaderIsNotHiddenByTheTokenTopFive', () => {
    mocks.users.byMetric = {
      messages: [row('Chatty', { messages: 400 }), row('Heavy tokens', { messages: 2 })],
      totalTokens: [row('Heavy tokens', { totalTokens: 100 })],
    };

    render(<UserRankCard />);
    const userRows = () => screen.getByTestId('bar-list').textContent ?? '';

    expect(mocks.users.orderBy).toBe('totalTokens');
    expect(userRows()).not.toContain('Chatty');

    fireEvent.click(screen.getByRole('button', { name: 'overview.rank.usersMetricMessages' }));

    expect(mocks.users.orderBy).toBe('messages');
    expect(userRows().indexOf('Chatty')).toBeLessThan(userRows().indexOf('Heavy tokens'));
  });
});
