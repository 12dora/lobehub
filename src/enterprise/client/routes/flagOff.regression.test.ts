import { matchRoutes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Flag-off must remove `/admin` from the **real** Business route exports,
 * not only from a test-only helper. Uses boot `window.__SERVER_CONFIG__` + resetModules.
 */

const setBootPlatformAdmin = (platformAdmin: boolean | undefined) => {
  if (platformAdmin === undefined) {
    window.__SERVER_CONFIG__ = undefined;
    return;
  }
  window.__SERVER_CONFIG__ = {
    analyticsConfig: {},
    clientEnv: {},
    config: {
      enterprise: {
        enabled: Boolean(platformAdmin),
        platformAdmin,
      },
    },
    featureFlags: {},
    isMobile: false,
  } as any;
};

const loadBusinessRoutes = async () => {
  vi.resetModules();
  const desktop = await import('@/business/client/BusinessDesktopRoutes');
  const mobile = await import('@/business/client/BusinessMobileRoutes');
  return { desktop, mobile };
};

describe('flag-off real Business route tree registration', () => {
  afterEach(() => {
    window.__SERVER_CONFIG__ = undefined;
  });

  it('flag false or absent: Business desktop/mobile do not register /admin', async () => {
    for (const flag of [false, undefined] as const) {
      setBootPlatformAdmin(flag);
      const { desktop, mobile } = await loadBusinessRoutes();

      expect(desktop.BusinessDesktopRoutesWithoutMainLayout).toEqual([]);
      expect(mobile.BusinessMobileRoutesWithoutMainLayout).toEqual([]);
      expect(matchRoutes(desktop.BusinessDesktopRoutesWithoutMainLayout, '/admin')).toBeNull();
      expect(matchRoutes(mobile.BusinessMobileRoutesWithoutMainLayout, '/admin')).toBeNull();
      expect(
        matchRoutes(desktop.BusinessDesktopRoutesWithoutMainLayout, '/admin/users'),
      ).toBeNull();
    }
  }, 20_000);

  it('flag true: Business desktop matches deep links and nested 404', async () => {
    setBootPlatformAdmin(true);
    const { desktop, mobile } = await loadBusinessRoutes();
    const routes = desktop.BusinessDesktopRoutesWithoutMainLayout;

    expect(routes.some((r) => r.path === '/admin')).toBe(true);
    expect(matchRoutes(routes, '/admin')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/users')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/users/u1')).toBeTruthy();
    expect(matchRoutes(routes, '/admin/ai/providers/p1')).toBeTruthy();

    const nestedUnknown = matchRoutes(routes, '/admin/does-not-exist');
    expect(nestedUnknown?.at(-1)?.route.path).toBe('*');

    expect(matchRoutes(mobile.BusinessMobileRoutesWithoutMainLayout, '/admin')).toBeTruthy();
  }, 20_000);

  it('web and electron share BusinessDesktopRoutesWithoutMainLayout (single mount)', async () => {
    setBootPlatformAdmin(true);
    const { desktop } = await loadBusinessRoutes();
    // Both desktopRouter.config.tsx and .desktop.tsx spread this same array.
    const paths = desktop.BusinessDesktopRoutesWithoutMainLayout.map((r) => r.path);
    expect(paths).toEqual(['/admin']);
    const children = desktop.BusinessDesktopRoutesWithoutMainLayout[0]?.children ?? [];
    const childPaths = children.map((c) => c.path).filter(Boolean);
    expect(childPaths).toContain('users');
    expect(childPaths).toContain('users/:id');
    expect(childPaths).toContain('ai/providers/:id');
  }, 20_000);

  it('flag off: zero admin.* adapter auto-calls on import', async () => {
    setBootPlatformAdmin(false);
    vi.resetModules();
    const adminAuth = await import('../services/adminAuth');
    const spy = vi.spyOn(adminAuth, 'fetchAdminAccess');
    await import('@/business/client/BusinessDesktopRoutes');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }, 20_000);
});
