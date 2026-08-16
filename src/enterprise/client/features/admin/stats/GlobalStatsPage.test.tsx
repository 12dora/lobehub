/**
 * Admin stats display-name cache must clear on signed-in account change.
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import GlobalStatsPage from './GlobalStatsPage';

const hoisted = vi.hoisted(() => {
  let userId: string | undefined = 'admin-a';
  const listeners = new Set<() => void>();
  return {
    get: vi.fn(),
    lookupLabel: undefined as string | null | undefined,
    resetCache: vi.fn(),
    get userId() {
      return userId;
    },
    setUserId(next: string | undefined) {
      userId = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/enterprise/client/features/admin/primitives/AdminPageTemplate', () => ({
  default: ({ actions, children }: { actions?: React.ReactNode; children?: React.ReactNode }) => (
    <div>
      <div data-testid="page-actions">{actions}</div>
      {children}
    </div>
  ),
}));

vi.mock('@/routes/(main)/settings/stats', () => ({
  default: ({
    headerNode,
    range,
    userId,
  }: {
    headerNode?: React.ReactNode;
    range?: { endAt: string; label: string; startAt: string };
    userId?: string;
  }) => (
    <div
      data-endat={range?.endAt}
      data-label={range?.label}
      data-startat={range?.startAt}
      data-testid="stats-setting"
      data-userid={userId ?? ''}
    >
      {headerNode}
    </div>
  ),
}));

vi.mock('./StatsUserFilterSelect', () => ({
  default: ({
    onChange,
    value,
    valueLabel,
  }: {
    onChange: (userId?: string, name?: string) => void;
    value?: string;
    valueLabel?: string;
  }) => (
    <div data-label={valueLabel ?? ''} data-testid="user-filter" data-value={value ?? ''}>
      <button type="button" onClick={() => onChange('u-7', 'Grace Hopper')}>
        pick
      </button>
      <button type="button" onClick={() => onChange(undefined)}>
        clear
      </button>
    </div>
  ),
  displayStatsUserLabel: (user: { fullName?: string | null; id: string }) =>
    user.fullName || user.id,
}));

vi.mock('@/enterprise/client/services/adminUsers', () => ({
  adminUsersService: { get: hoisted.get },
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>) => {
    if (key !== null) void fetcher();
    return { data: hoisted.lookupLabel, error: undefined, isLoading: false, mutate: vi.fn() };
  },
}));

vi.mock('./adminStatsDataSource', () => ({
  adminGlobalStatsDataSource: { scopeKey: 'admin-global' },
  resetAdminStatsUserDisplayCache: () => hoisted.resetCache(),
  resolveAdminStatsUser: (id: string) => ({ avatar: null, name: id }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: { user?: { id?: string } }) => unknown) => {
    const [, setTick] = useState(0);
    useEffect(() => hoisted.subscribe(() => setTick((n) => n + 1)), []);
    return selector({ user: hoisted.userId ? { id: hoisted.userId } : undefined });
  },
}));

vi.mock('@/store/user/selectors', () => ({
  userProfileSelectors: {
    userId: (s: { user?: { id?: string } }) => s.user?.id,
  },
}));

const Probe = () => <span data-testid="search">{useLocation().search}</span>;

describe('GlobalStatsPage cache reset', () => {
  beforeEach(() => {
    hoisted.setUserId('admin-a');
    hoisted.resetCache.mockClear();
    hoisted.lookupLabel = undefined;
    hoisted.get.mockReset().mockResolvedValue({ fullName: 'Ada Lovelace', id: 'u-42' });
  });

  const renderPage = (search = '') =>
    render(
      <MemoryRouter initialEntries={[`/admin/stats${search}`]}>
        <GlobalStatsPage />
        <Probe />
      </MemoryRouter>,
    );

  it('clears the user display cache on mount and when the account changes', () => {
    renderPage();
    expect(hoisted.resetCache).toHaveBeenCalledTimes(1);

    act(() => {
      hoisted.setUserId('admin-b');
    });
    expect(hoisted.resetCache).toHaveBeenCalledTimes(2);
  });

  it('defaultsToTheThirtyDayWindowAndPassesItToTheSharedStatsPage', () => {
    renderPage();
    const page = screen.getByTestId('stats-setting');
    expect(page.dataset.label).toBe('timeRange.preset.30d');
    expect(page.dataset.startat).toBeTruthy();
    expect(page.dataset.endat).toBeTruthy();
    expect(page.dataset.userid).toBe('');
  });

  it('readsTheRangeAndUserFilterBackFromTheUrl', () => {
    renderPage('?range=today&user=u-42');
    const page = screen.getByTestId('stats-setting');
    expect(page.dataset.label).toBe('timeRange.preset.today');
    expect(page.dataset.userid).toBe('u-42');
  });

  it('rendersTheUserFilterInThePageActionRow', () => {
    renderPage();

    // The picker moved out of the section header into the page actions, where it sits
    // to the left of the time-range filter.
    expect(screen.getByTestId('page-actions').contains(screen.getByTestId('user-filter'))).toBe(
      true,
    );
  });

  it('resolvesABookmarkedUserIdIntoANameForThePicker', () => {
    hoisted.lookupLabel = 'Ada Lovelace';
    renderPage('?user=u-42');

    expect(hoisted.get).toHaveBeenCalledWith({ userId: 'u-42' });
    expect(screen.getByTestId('user-filter').dataset.label).toBe('Ada Lovelace');
    expect(screen.getByTestId('stats-setting').dataset.userid).toBe('u-42');
  });

  it('labelsAnUnknownOrDeniedUserWithItsIdRatherThanClaimingAllUsers', () => {
    hoisted.lookupLabel = null;
    renderPage('?user=u-ghost');

    expect(screen.getByTestId('stats-setting').dataset.userid).toBe('u-ghost');
    expect(screen.getByTestId('user-filter').dataset.label).toBe('u-ghost');
  });

  it.each([
    ['an empty value', '?user='],
    ['whitespace only', '?user=%20%20'],
    ['an id past the server bound', `?user=${'x'.repeat(129)}`],
  ])('canonicalizes %s out of the URL instead of querying an invalid id', (_label, url) => {
    renderPage(url);

    expect(screen.getByTestId('search').textContent).toBe('');
    expect(screen.getByTestId('stats-setting').dataset.userid).toBe('');
    expect(screen.getByTestId('user-filter').dataset.label).toBe('');
    expect(hoisted.get).not.toHaveBeenCalled();
  });

  it('trimsAPaddedIdAndKeepsTheLabelInSyncWhenTheSelectionChanges', () => {
    renderPage('?user=%20u-42%20');
    expect(screen.getByTestId('search').textContent).toBe('?user=u-42');

    // Picking through the dropdown already knows the name — no lookup for that id.
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    expect(screen.getByTestId('search').textContent).toBe('?user=u-7');
    expect(screen.getByTestId('user-filter').dataset.label).toBe('Grace Hopper');
    expect(hoisted.get).not.toHaveBeenCalledWith({ userId: 'u-7' });

    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(screen.getByTestId('search').textContent).toBe('');
    expect(screen.getByTestId('stats-setting').dataset.userid).toBe('');
  });
});
