import { twoFactor } from 'better-auth/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enforceTwoFactorSessionGate } from './session-gate';
import { EXTRA_2FA_CHALLENGE_PATHS, withTwoFactorChallengedPaths } from './with-challenged-paths';

const mocks = vi.hoisted(() => ({
  clearOrphanedTwoFactorEnabled: vi.fn(async () => false),
  getCurrentAuthContext: vi.fn(),
  getTwoFactorEnrollmentState: vi.fn(async () => ({
    enabled: true,
    hasVerifiedFactor: true,
  })),
}));

vi.mock('@better-auth/core/context', () => ({
  getCurrentAuthContext: (...args: unknown[]) => mocks.getCurrentAuthContext(...args),
}));

vi.mock('@/database/models/twoFactor', () => ({
  clearOrphanedTwoFactorEnabled: mocks.clearOrphanedTwoFactorEnabled,
  getTwoFactorEnrollmentState: mocks.getTwoFactorEnrollmentState,
}));

const STOCK_2FA_PATHS = ['/sign-in/email', '/sign-in/username', '/sign-in/phone-number'] as const;

const pathCtx = (path: string) => ({ path }) as never;

describe('withTwoFactorChallengedPaths', () => {
  it('widens the stock matcher and keeps the stock handler', () => {
    const base = twoFactor({ issuer: 'test' });
    const stock = base.hooks?.after?.[0];
    if (!stock) throw new Error('better-auth twoFactor() no longer exposes hooks.after[0]');

    const wrapped = withTwoFactorChallengedPaths(base);
    const after = wrapped.hooks?.after ?? [];
    const widened = after[0];
    if (!widened) throw new Error('wrapper dropped hooks.after[0]');

    // Same handler — we must not copy the challenge body or the cookie name.
    expect(widened.handler).toBe(stock.handler);
    expect(after).toHaveLength((base.hooks?.after?.length ?? 0) + 1);

    for (const path of STOCK_2FA_PATHS) {
      expect(stock.matcher(pathCtx(path))).toBe(true);
      expect(widened.matcher(pathCtx(path))).toBe(true);
    }

    for (const path of EXTRA_2FA_CHALLENGE_PATHS) {
      expect(stock.matcher(pathCtx(path))).toBe(false);
      expect(widened.matcher(pathCtx(path))).toBe(true);
    }

    // OAuth answers with a redirect — must not be challenged.
    expect(widened.matcher(pathCtx('/callback/google'))).toBe(false);
    expect(widened.matcher(pathCtx('/oauth2/callback/corp-oidc'))).toBe(false);

    const rewrite = after.at(-1);
    if (!rewrite) throw new Error('missing navigation rewrite hook');
    expect(rewrite.matcher(pathCtx('/magic-link/verify'))).toBe(true);
    expect(rewrite.matcher(pathCtx('/verify-email'))).toBe(true);
    expect(rewrite.matcher(pathCtx('/sign-in/email-otp'))).toBe(false);
    expect(rewrite.matcher(pathCtx('/callback/google'))).toBe(false);
  });
});

describe('gate × challenge interaction', () => {
  const db = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTwoFactorEnrollmentState.mockResolvedValue({
      enabled: true,
      hasVerifiedFactor: true,
    });
    mocks.getCurrentAuthContext.mockRejectedValue(new Error('no request context'));
  });

  it('lets a TOTP-enabled magic-link sign-in through the gate so the widened hook can issue twoFactorRedirect', async () => {
    await enforceTwoFactorSessionGate({
      context: { path: '/magic-link/verify' },
      db,
      userId: 'totp-user',
    });

    const wrapped = withTwoFactorChallengedPaths(twoFactor({ issuer: 'test' }));
    const hook = wrapped.hooks?.after?.[0];
    if (!hook) throw new Error('missing after hook');

    expect(hook.matcher(pathCtx('/magic-link/verify'))).toBe(true);
  });

  it('lets a TOTP-enabled email-OTP sign-in through the gate so the widened hook can issue twoFactorRedirect', async () => {
    await enforceTwoFactorSessionGate({
      context: { path: '/sign-in/email-otp' },
      db,
      userId: 'totp-user',
    });

    const wrapped = withTwoFactorChallengedPaths(twoFactor({ issuer: 'test' }));
    const hook = wrapped.hooks?.after?.[0];
    if (!hook) throw new Error('missing after hook');

    expect(hook.matcher(pathCtx('/sign-in/email-otp'))).toBe(true);
  });
});
