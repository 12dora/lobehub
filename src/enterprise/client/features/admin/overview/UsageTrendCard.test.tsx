// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UsageTrendCard from './UsageTrendCard';

const mocks = vi.hoisted(() => ({
  data: undefined as Array<{ day: string; tokens: number }> | undefined,
  error: undefined as Error | undefined,
  isLoading: false,
  mutate: vi.fn(),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/charts', () => ({
  AreaChart: () => <div data-testid="area-chart" />,
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
  Skeleton: { Block: () => <div data-testid="skeleton" /> },
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('./useOverviewStats', () => ({
  useOverviewUsageTrend: () => ({
    data: mocks.data,
    error: mocks.error,
    isLoading: mocks.isLoading,
    mutate: mocks.mutate,
  }),
}));

describe('AdminOverviewUsageTrendCard', () => {
  beforeEach(() => {
    mocks.data = undefined;
    mocks.error = undefined;
    mocks.isLoading = false;
    mocks.mutate.mockReset();
  });

  it('rendersRetryableErrorOnInitialFailure', () => {
    mocks.error = new Error('denied');
    render(<UsageTrendCard />);
    expect(screen.getByTestId('alert-error')).toHaveTextContent('overview.error.loadFailed');
    fireEvent.click(screen.getByRole('button', { name: 'overview.error.retry' }));
    expect(mocks.mutate).toHaveBeenCalled();
    expect(screen.queryByTestId('area-chart')).toBeNull();
  });

  it('preservesEmptyStateWithRefreshWarningOnStaleEmptyRefreshFailure', () => {
    // Stale empty series + revalidation error must not force a blank AreaChart.
    mocks.data = [
      { day: '2026-07-01', tokens: 0 },
      { day: '2026-07-02', tokens: 0 },
    ];
    mocks.error = new Error('refresh failed');
    render(<UsageTrendCard />);
    expect(screen.getByTestId('alert-warning')).toHaveTextContent('overview.error.refreshFailed');
    expect(screen.getByText('overview.usage.emptyTitle')).toBeTruthy();
    expect(screen.queryByTestId('area-chart')).toBeNull();
  });

  it('keepsStaleChartDataWithRefreshWarning', () => {
    mocks.data = [{ day: '2026-07-01', tokens: 42 }];
    mocks.error = new Error('refresh failed');
    render(<UsageTrendCard />);
    expect(screen.getByTestId('alert-warning')).toHaveTextContent('overview.error.refreshFailed');
    expect(screen.getByTestId('area-chart')).toBeTruthy();
  });
});
