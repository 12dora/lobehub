// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Import after mocks.
import { GlobalStatsBanner } from './GlobalStatsBanner';

const mocks = vi.hoisted(() => ({
  data: undefined as { usersActive: number; usersTotal: number } | undefined,
  error: undefined as Error | undefined,
  fetcher: null as null | (() => Promise<unknown>),
  isLoading: false,
  key: null as unknown,
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
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>) => {
    mocks.key = key;
    mocks.fetcher = fetcher;
    return {
      data: mocks.data,
      error: mocks.error,
      isLoading: mocks.isLoading,
      mutate: mocks.mutate,
    };
  },
}));

vi.mock('@/enterprise/client/services/adminStats', () => ({
  adminStatsService: {
    userTotals: mocks.userTotals,
  },
}));

describe('GlobalStatsBanner', () => {
  const RANGE = {
    endAt: '2026-07-22T15:30:00.000Z',
    key: '7d' as const,
    label: 'Last 7 days',
    startAt: '2026-07-16T00:00:00.000Z',
  };

  beforeEach(() => {
    mocks.data = undefined;
    mocks.error = undefined;
    mocks.fetcher = null;
    mocks.isLoading = false;
    mocks.key = null;
    mocks.mutate.mockReset();
    mocks.userTotals.mockReset().mockResolvedValue({ usersActive: 4, usersTotal: 12 });
  });

  it('rendersRetryableErrorOnInitialFailure', () => {
    mocks.error = new Error('denied');
    render(<GlobalStatsBanner />);
    expect(screen.getByTestId('alert-error')).toHaveTextContent('stats.banner.error');
    fireEvent.click(screen.getByRole('button', { name: 'stats.banner.retry' }));
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it('scopesItsOwnRequestAndCacheKeyToTheSelectedUser', async () => {
    mocks.data = { usersActive: 4, usersTotal: 12 };
    render(<GlobalStatsBanner range={RANGE} userId={'u-42'} userName={'Ada Lovelace'} />);

    // The banner claims the page is pinned to one user — so its own figures must be
    // asked for under that scope, and cached apart from the all-users answer.
    expect(mocks.key).toEqual(expect.arrayContaining([RANGE.startAt, RANGE.endAt, 'u-42']));
    await mocks.fetcher!();
    expect(mocks.userTotals).toHaveBeenCalledWith(undefined, {
      endAt: RANGE.endAt,
      startAt: RANGE.startAt,
      userId: 'u-42',
    });
  });

  it('labelsActiveUsersWithTheSelectedRangeAndNamesASingleUserScope', () => {
    mocks.data = { usersActive: 4, usersTotal: 12 };
    render(<GlobalStatsBanner range={RANGE} userId={'u-42'} userName={'Ada Lovelace'} />);
    expect(screen.getByText('stats.banner.usersActiveInRange')).toBeTruthy();
    expect(screen.getByText('stats.banner.userScopeNote')).toBeTruthy();
    // The removed global scope note must not come back.
    expect(screen.queryByText('stats.banner.scopeNote')).toBeNull();
  });

  it('omitsTheUserScopeNoteWhenNoUserIsSelected', async () => {
    mocks.data = { usersActive: 4, usersTotal: 12 };
    render(<GlobalStatsBanner />);
    expect(screen.queryByText('stats.banner.userScopeNote')).toBeNull();
    expect(screen.getByText('stats.banner.usersActive')).toBeTruthy();

    await mocks.fetcher!();
    expect(mocks.userTotals).toHaveBeenCalledWith(30, {
      endAt: undefined,
      startAt: undefined,
      userId: undefined,
    });
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
