import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerConfigStoreProvider } from '@/store/serverConfig/Provider';
import { useUserStore } from '@/store/user';

import { useMenu } from '../UserPanel/useMenu';

const wrapper: React.JSXElementConstructor<{ children: React.ReactNode }> = ({ children }) => (
  <ServerConfigStoreProvider>{children}</ServerConfigStoreProvider>
);

// Mock dependencies
vi.mock('next/link', () => ({
  default: vi.fn(({ children }) => <div>{children}</div>),
}));

vi.mock('@/hooks/useQueryRoute', () => ({
  useQueryRoute: vi.fn(() => ({
    push: vi.fn(),
  })),
}));

vi.mock('@/hooks/useInterceptingRoutes', () => ({
  useOpenSettings: vi.fn(() => vi.fn()),
}));

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key) => key),
  })),
}));

vi.mock('@/services/config', () => ({
  configService: {
    exportAgents: vi.fn(),
    exportAll: vi.fn(),
    exportSessions: vi.fn(),
    exportSettings: vi.fn(),
  },
}));

vi.mock('./useNewVersion', () => ({
  useNewVersion: vi.fn(() => false),
}));

const hasAdminEntry = vi.fn(() => false);

vi.mock('../UserPanel/useHasAdminEntry', () => ({
  useHasAdminEntry: () => hasAdminEntry(),
}));

describe('useMenu', () => {
  beforeEach(() => {
    hasAdminEntry.mockReturnValue(false);
  });

  it('should provide correct menu items when user is logged in with auth', () => {
    act(() => {
      useUserStore.setState({ isSignedIn: true });
    });

    const { result } = renderHook(() => useMenu(), { wrapper });

    act(() => {
      const { mainItems, logoutItems } = result.current;
      // 'setting' is shown when logged in
      expect(mainItems?.some((item) => item?.key === 'setting')).toBe(true);
      // 'memory' is gated behind the showMemory nav-layout flag (defaults off)
      expect(mainItems?.some((item) => item?.key === 'memory')).toBe(false);
      // 'logout' is shown when isLoginWithAuth is true
      expect(logoutItems.some((item) => item?.key === 'logout')).toBe(true);
    });
  });

  it('should provide correct menu items when user is not logged in', () => {
    act(() => {
      useUserStore.setState({ isSignedIn: false });
    });

    const { result } = renderHook(() => useMenu(), { wrapper });

    act(() => {
      const { mainItems, logoutItems } = result.current;
      // When not logged in, setting and memory should not be shown
      expect(mainItems?.some((item) => item?.key === 'setting')).toBe(false);
      expect(mainItems?.some((item) => item?.key === 'memory')).toBe(false);
      expect(logoutItems.some((item) => item?.key === 'logout')).toBe(false);
    });
  });

  it('should show the admin console entry only for users with admin access', () => {
    act(() => {
      useUserStore.setState({ isSignedIn: true });
    });

    const { result: withoutAccess } = renderHook(() => useMenu(), { wrapper });
    expect(withoutAccess.current.mainItems?.some((item) => item?.key === 'admin-console')).toBe(
      false,
    );

    hasAdminEntry.mockReturnValue(true);
    const { result: withAccess } = renderHook(() => useMenu(), { wrapper });
    expect(withAccess.current.mainItems?.some((item) => item?.key === 'admin-console')).toBe(true);
  });

  it('should not show the admin console entry when the user is not logged in', () => {
    act(() => {
      useUserStore.setState({ isSignedIn: false });
    });
    hasAdminEntry.mockReturnValue(true);

    const { result } = renderHook(() => useMenu(), { wrapper });

    expect(result.current.mainItems?.some((item) => item?.key === 'admin-console')).toBe(false);
  });

  it('should not have consecutive dividers in mainItems', () => {
    act(() => {
      useUserStore.setState({ isSignedIn: true });
    });

    const { result } = renderHook(() => useMenu(), { wrapper });

    act(() => {
      const { mainItems } = result.current;
      if (!mainItems) return;

      for (let i = 1; i < mainItems.length; i++) {
        const prev = mainItems[i - 1];
        const curr = mainItems[i];
        const isDivider = (item: any) =>
          item && typeof item === 'object' && item.type === 'divider';
        expect(isDivider(prev) && isDivider(curr)).toBe(false);
      }
    });
  });
});
