import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractBetterAuthPath,
  isBlockedBetterAuthAdminPath,
  maybeBlockBetterAuthAdminMutation,
  PLATFORM_BLOCKED_BETTER_AUTH_ADMIN_PATHS,
} from './betterAuthAdminBlock';

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

  it('lists every forbidden mutation/read admin endpoint', () => {
    for (const p of [
      '/admin/ban-user',
      '/admin/unban-user',
      '/admin/revoke-user-sessions',
      '/admin/set-role',
      '/admin/remove-user',
      '/admin/impersonate-user',
      '/admin/set-user-password',
    ]) {
      expect(isBlockedBetterAuthAdminPath(p)).toBe(true);
      expect(PLATFORM_BLOCKED_BETTER_AUTH_ADMIN_PATHS).toContain(p);
    }
    expect(isBlockedBetterAuthAdminPath('/sign-in/email')).toBe(false);
    expect(isBlockedBetterAuthAdminPath('/get-session')).toBe(false);
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
    }
  });

  it('flag-on still allows normal login/session paths', () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    expect(maybeBlockBetterAuthAdminMutation('https://x/api/auth/sign-in/email')).toBeNull();
    expect(maybeBlockBetterAuthAdminMutation('https://x/api/auth/get-session')).toBeNull();
    expect(maybeBlockBetterAuthAdminMutation('https://x/api/auth/sign-out')).toBeNull();
  });
});
