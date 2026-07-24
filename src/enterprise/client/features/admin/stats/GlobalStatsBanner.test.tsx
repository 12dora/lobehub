// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Import after mocks.
import { GlobalStatsBanner } from './GlobalStatsBanner';

const mocks = vi.hoisted(() => ({
  data: undefined as { usersActive: number; usersTotal: number } | undefined,
  error: undefined as Error | undefined,
  isLoading: false,
  mutate: vi.fn(),
  userTotals: vi.fn(),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Skeleton: { Button: () => <div data-testid="skeleton" /> },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: () => ({
    data: mocks.data,
    error: mocks.error,
    isLoading: mocks.isLoading,
    mutate: mocks.mutate,
  }),
}));

vi.mock('@/enterprise/client/services/adminStats', () => ({
  adminStatsService: {
    userTotals: mocks.userTotals,
  },
}));

describe('GlobalStatsBanner', () => {
  beforeEach(() => {
    mocks.data = undefined;
    mocks.error = undefined;
    mocks.isLoading = false;
    mocks.mutate.mockReset();
  });

  it('rendersRetryableErrorOnInitialFailure', () => {
    mocks.error = new Error('denied');
    render(<GlobalStatsBanner />);
    expect(screen.getByTestId('alert-error')).toHaveTextContent('stats.banner.error');
    fireEvent.click(screen.getByRole('button', { name: 'stats.banner.retry' }));
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it('preservesStaleTotalsWithRefreshWarningOnRevalidationFailure', () => {
    mocks.data = { usersActive: 4, usersTotal: 12 };
    mocks.error = new Error('refresh failed');
    render(<GlobalStatsBanner />);
    expect(screen.getByTestId('alert-warning')).toHaveTextContent('stats.banner.refreshFailed');
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });
});
