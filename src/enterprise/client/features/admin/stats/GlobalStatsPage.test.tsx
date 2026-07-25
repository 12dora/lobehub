/**
 * Admin stats display-name cache must clear on signed-in account change.
 * @vitest-environment happy-dom
 */
import { act, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import GlobalStatsPage from './GlobalStatsPage';

const hoisted = vi.hoisted(() => {
  let userId: string | undefined = 'admin-a';
  const listeners = new Set<() => void>();
  return {
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
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/routes/(main)/settings/stats', () => ({
  default: () => <div data-testid="stats-setting" />,
}));

vi.mock('./GlobalStatsBanner', () => ({
  GlobalStatsBanner: () => <div data-testid="banner" />,
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

describe('GlobalStatsPage cache reset', () => {
  beforeEach(() => {
    hoisted.setUserId('admin-a');
    hoisted.resetCache.mockClear();
  });

  it('clears the user display cache on mount and when the account changes', () => {
    render(<GlobalStatsPage />);
    expect(hoisted.resetCache).toHaveBeenCalledTimes(1);

    act(() => {
      hoisted.setUserId('admin-b');
    });
    expect(hoisted.resetCache).toHaveBeenCalledTimes(2);
  });
});
