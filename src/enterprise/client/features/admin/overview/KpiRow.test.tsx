// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import KpiRow from './KpiRow';

const mocks = vi.hoisted(() => ({
  data: undefined as
    | {
        agents: number;
        messages: number;
        topics: number;
        usersActive: number;
        usersTotal: number;
      }
    | undefined,
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
  Skeleton: { Button: () => <div data-testid="skeleton" /> },
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('./useOverviewStats', () => ({
  useOverviewKpis: () => ({
    data: mocks.data,
    error: mocks.error,
    isLoading: mocks.isLoading,
    mutate: mocks.mutate,
  }),
}));

describe('AdminOverviewKpiRow', () => {
  beforeEach(() => {
    mocks.data = undefined;
    mocks.error = undefined;
    mocks.isLoading = false;
    mocks.mutate.mockReset();
  });

  it('rendersRetryableErrorAfterOverviewFetchFailure', () => {
    mocks.error = new Error('denied');
    render(<KpiRow />);
    expect(screen.getByTestId('alert-error')).toHaveTextContent('overview.error.loadFailed');
    fireEvent.click(screen.getByRole('button', { name: 'overview.error.retry' }));
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it('preservesStaleKpisWithRefreshWarningOnRevalidationFailure', () => {
    mocks.data = {
      agents: 1,
      messages: 2,
      topics: 3,
      usersActive: 4,
      usersTotal: 5,
    };
    mocks.error = new Error('refresh failed');
    render(<KpiRow />);
    expect(screen.getByTestId('alert-warning')).toHaveTextContent('overview.error.refreshFailed');
    // Stale metric values remain visible (formatted numbers).
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });
});
