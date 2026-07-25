import { readFileSync } from 'node:fs';
import path from 'node:path';

import { matchRoutes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBusinessDesktopRoutesWithoutMainLayout } from '@/business/client/BusinessDesktopRoutes';
import { enterpriseModuleRegistry } from '@/enterprise/client/registry';
// Real production snapshot — evaluated once at collect time (before late register).
import { desktopRoutes } from '@/spa/router/desktopRouter.config';

/**
 * CS-05 option (b): dynamic enterprise module registration is not supported
 * against the frozen `desktopRoutes` tree. The public barrel must not export
 * register(); matching the real desktop route tree after a late register stays null.
 *
 * createAdminRouteTree is stubbed so vitest does not load the full admin shell
 * graph. desktopRoutes is a **static** import (same as desktopRouter.sync.test):
 * collecting the config graph is ~100s once; `vi.resetModules()` + dynamic
 * re-import redoes that under a short timeout and hangs the suite.
 */

vi.mock('@/enterprise/client/routes/admin/createAdminRouteTree', () => ({
  createAdminRouteTree: (extensionRoutes: unknown[]) => [
    {
      children: extensionRoutes,
      path: '/admin',
    },
  ],
}));

vi.mock('@/enterprise/client/boot/isPlatformAdminBootEnabled', () => ({
  isPlatformAdminBootEnabled: () => true,
}));

describe('BusinessDesktopRoutes / desktopRoutes registration boundary (CS-05)', () => {
  afterEach(() => {
    window.__SERVER_CONFIG__ = undefined;
  });

  it('public barrel does not export enterpriseModuleRegistry or createEnterpriseModuleRegistry', () => {
    const indexSource = readFileSync(
      path.join(__dirname, '../../enterprise/client/index.ts'),
      'utf8',
    );
    expect(indexSource).not.toMatch(/enterpriseModuleRegistry,/);
    expect(indexSource).not.toMatch(/export \{[^}]*enterpriseModuleRegistry/);
    expect(indexSource).not.toMatch(/createEnterpriseModuleRegistry/);
    // Types-only re-export is fine
    expect(indexSource).toMatch(/export type \{[^}]*EnterpriseModuleRegistry/);
  });

  it('late register after desktopRoutes load does not appear in the real desktopRoutes tree', () => {
    const moduleId = `late-acme-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    enterpriseModuleRegistry.register({
      id: moduleId,
      routes: [
        {
          element: null,
          handle: { admin: { id: 'acme', requiredPermissions: [] } },
          path: '/admin/extensions/acme',
        },
      ],
    });

    // Finding reproduction: late register → match real desktopRoutes.
    // The tree's catch-all `*` still matches the URL, but the registered
    // `/admin/extensions/acme` child is absent (snapshot frozen at eval).
    const matched = matchRoutes(desktopRoutes, '/admin/extensions/acme');
    const matchedPaths = (matched ?? []).map((m) => m.route.path);
    expect(matchedPaths).not.toContain('/admin');
    expect(matchedPaths.some((p) => typeof p === 'string' && p.includes('extensions/acme'))).toBe(
      false,
    );
    expect(matchedPaths.at(-1)).toBe('*');

    // Contrast: the live getter still sees the registration — proving the gap
    // is the frozen desktopRoutes snapshot, not the registry itself.
    const live = getBusinessDesktopRoutesWithoutMainLayout();
    const liveMatch = matchRoutes(live, '/admin/extensions/acme');
    expect(liveMatch).toBeTruthy();
    expect(liveMatch?.[0]?.route.path).toBe('/admin');
  });
});
