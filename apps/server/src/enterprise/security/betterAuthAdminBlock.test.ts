// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractBetterAuthPath,
  isBlockedBetterAuthAdminPath,
  maybeBlockBetterAuthAdminMutation,
  PLATFORM_BLOCKED_BETTER_AUTH_ADMIN_PATHS,
} from './betterAuthAdminBlock';

const require = createRequire(import.meta.url);

/** Resolve installed better-auth admin route inventory from the dependency sources. */
const readInstalledBetterAuthAdminPaths = (): string[] => {
  // package.json is not export-mapped; resolve a real entry then walk to dist.
  const betterAuthEntry = require.resolve('better-auth');
  const packageRoot = betterAuthEntry.includes('/dist/')
    ? betterAuthEntry.slice(0, betterAuthEntry.lastIndexOf('/dist/'))
    : dirname(betterAuthEntry);
  const routesPath = join(packageRoot, 'dist/plugins/admin/routes.mjs');
  const source = readFileSync(routesPath, 'utf8');
  const paths = [...source.matchAll(/createAuthEndpoint\("(\/admin\/[^"]+)"/g)].map(
    (match) => match[1]!,
  );
  return [...new Set(paths)].sort();
};

describe('betterAuthAdminBlock', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('extracts path after /api/auth', () => {
    expect(extractBetterAuthPath('https://app.example/api/auth/admin/ban-user')).toBe(
      '/admin/ban-user',
    );
    expect(extractBetterAuthPath('/api/auth/admin/set-role')).toBe('/admin/set-role');
  });

  it('lists every forbidden mutation/read admin endpoint including has-permission', () => {
    for (const p of [
      '/admin/ban-user',
      '/admin/unban-user',
      '/admin/revoke-user-sessions',
      '/admin/set-role',
      '/admin/remove-user',
      '/admin/impersonate-user',
      '/admin/set-user-password',
      '/admin/has-permission',
    ]) {
      expect(isBlockedBetterAuthAdminPath(p)).toBe(true);
      expect(PLATFORM_BLOCKED_BETTER_AUTH_ADMIN_PATHS).toContain(p);
    }
    expect(isBlockedBetterAuthAdminPath('/admin/user-has-permission')).toBe(false);
    expect(isBlockedBetterAuthAdminPath('/sign-in/email')).toBe(false);
    expect(isBlockedBetterAuthAdminPath('/get-session')).toBe(false);
  });

  it('reconciles the denylist against the installed better-auth admin endpoint inventory', () => {
    const installed = readInstalledBetterAuthAdminPaths();
    expect(installed.length).toBeGreaterThan(0);
    expect(installed).toContain('/admin/has-permission');
    expect(installed).not.toContain('/admin/user-has-permission');

    for (const path of installed) {
      expect(
        PLATFORM_BLOCKED_BETTER_AUTH_ADMIN_PATHS,
        `missing denylist entry for installed better-auth admin path ${path}`,
      ).toContain(path);
    }
  });

  it('flag-off allows admin plugin paths (upstream-compatible)', () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    expect(maybeBlockBetterAuthAdminMutation('https://x/api/auth/admin/ban-user')).toBeNull();
  });

  it('flag-on blocks every forbidden endpoint with 403', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    for (const path of PLATFORM_BLOCKED_BETTER_AUTH_ADMIN_PATHS) {
      const res = maybeBlockBetterAuthAdminMutation(`https://x/api/auth${path}`);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
      const body = await res!.json();
      expect(body.code).toBe('ADMIN_FEATURE_DISABLED');
      expect(body.message).toBe('ADMIN_FEATURE_DISABLED');
    }
  });

  it('flag-on still allows normal login/session paths', () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    expect(maybeBlockBetterAuthAdminMutation('https://x/api/auth/sign-in/email')).toBeNull();
    expect(maybeBlockBetterAuthAdminMutation('https://x/api/auth/get-session')).toBeNull();
    expect(maybeBlockBetterAuthAdminMutation('https://x/api/auth/sign-out')).toBeNull();
  });
});
