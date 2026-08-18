import { APIError } from 'better-auth/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enforceTwoFactorSessionGate,
  isTwoFactorSessionPathAllowed,
  resolveAuthRequestPath,
  TWO_FACTOR_REQUIRED_CODE,
  TWO_FACTOR_REQUIRED_MESSAGE,
  TWO_FACTOR_SESSION_ALLOWED_PATHS,
} from './session-gate';

const mocks = vi.hoisted(() => ({
  clearOrphanedTwoFactorEnabled: vi.fn(async () => false),
  getCurrentAuthContext: vi.fn(),
  getTwoFactorEnrollmentState: vi.fn(async () => ({ enabled: false, hasVerifiedFactor: false })),
}));

vi.mock('@better-auth/core/context', () => ({
  getCurrentAuthContext: (...args: unknown[]) => mocks.getCurrentAuthContext(...args),
}));

vi.mock('@/database/models/twoFactor', () => ({
  clearOrphanedTwoFactorEnabled: mocks.clearOrphanedTwoFactorEnabled,
  getTwoFactorEnrollmentState: mocks.getTwoFactorEnrollmentState,
}));

const expectTwoFactorRequired = async (fn: () => Promise<void>) => {
  try {
    await fn();
    expect.unreachable('expected TWO_FACTOR_REQUIRED');
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    const apiError = error as InstanceType<typeof APIError>;
    expect(apiError.body?.code).toBe(TWO_FACTOR_REQUIRED_CODE);
    expect(apiError.body?.message).toBe(TWO_FACTOR_REQUIRED_MESSAGE);
  }
};

describe('isTwoFactorSessionPathAllowed', () => {
  it.each([
    '/two-factor/verify-totp',
    '/two-factor/verify-backup-code',
    '/two-factor/verify-otp',
    '/passkey/verify-authentication',
    '/sign-in/email',
    '/sign-in/username',
    '/sign-in/phone-number',
    '/magic-link/verify',
    '/sign-in/email-otp',
    '/verify-email',
    '/change-password',
    '/admin/impersonate-user',
  ])('allows %s', (path) => {
    expect(TWO_FACTOR_SESSION_ALLOWED_PATHS.has(path)).toBe(true);
    expect(isTwoFactorSessionPathAllowed(path)).toBe(true);
  });

  it.each(['/callback/google', '/oauth2/callback/corp-oidc', '/oauth2/callback/:providerId'])(
    'allows SSO callback %s (prefix, not challenged)',
    (path) => {
      expect(isTwoFactorSessionPathAllowed(path)).toBe(true);
    },
  );

  it.each([null, undefined, ''])('allows a create with no HTTP path (%s)', (path) => {
    expect(isTwoFactorSessionPathAllowed(path)).toBe(true);
  });

  it.each(['/sign-in/social', '/sign-up/email', '/sign-in/magic-link'])(
    'refuses unknown sign-in path %s',
    (path) => {
      expect(isTwoFactorSessionPathAllowed(path)).toBe(false);
    },
  );
});

describe('resolveAuthRequestPath', () => {
  beforeEach(() => {
    mocks.getCurrentAuthContext.mockReset();
  });

  it('prefers the context argument', async () => {
    await expect(resolveAuthRequestPath({ path: '/sign-in/email' })).resolves.toBe(
      '/sign-in/email',
    );
    expect(mocks.getCurrentAuthContext).not.toHaveBeenCalled();
  });

  it('falls back to getCurrentAuthContext when the argument has no path', async () => {
    mocks.getCurrentAuthContext.mockResolvedValue({ path: '/callback/google' });
    await expect(resolveAuthRequestPath({})).resolves.toBe('/callback/google');
  });

  it('returns null when there is no request context', async () => {
    mocks.getCurrentAuthContext.mockRejectedValue(new Error('no request context'));
    await expect(resolveAuthRequestPath()).resolves.toBeNull();
  });
});

describe('enforceTwoFactorSessionGate', () => {
  const db = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTwoFactorEnrollmentState.mockResolvedValue({
      enabled: false,
      hasVerifiedFactor: false,
    });
    mocks.clearOrphanedTwoFactorEnabled.mockResolvedValue(false);
    mocks.getCurrentAuthContext.mockRejectedValue(new Error('no request context'));
  });

  it('does nothing when two-factor is off', async () => {
    await enforceTwoFactorSessionGate({ context: { path: '/callback/google' }, db, userId: 'u1' });
    expect(mocks.clearOrphanedTwoFactorEnabled).not.toHaveBeenCalled();
  });

  it('repairs an orphaned enabled flag and allows the session', async () => {
    mocks.getTwoFactorEnrollmentState.mockResolvedValue({
      enabled: true,
      hasVerifiedFactor: false,
    });

    await enforceTwoFactorSessionGate({ context: { path: '/callback/google' }, db, userId: 'u1' });

    expect(mocks.clearOrphanedTwoFactorEnabled).toHaveBeenCalledWith(db, 'u1');
  });

  it.each([...TWO_FACTOR_SESSION_ALLOWED_PATHS])(
    'allows a TOTP-enabled user on %s',
    async (path) => {
      mocks.getTwoFactorEnrollmentState.mockResolvedValue({
        enabled: true,
        hasVerifiedFactor: true,
      });

      await enforceTwoFactorSessionGate({ context: { path }, db, userId: 'u1' });
    },
  );

  it('allows a TOTP-enabled user when there is no HTTP path', async () => {
    mocks.getTwoFactorEnrollmentState.mockResolvedValue({
      enabled: true,
      hasVerifiedFactor: true,
    });

    await enforceTwoFactorSessionGate({ db, userId: 'u1' });
  });

  it.each(['/sign-in/social', '/sign-up/email'])(
    'refuses a TOTP-enabled user on unknown path %s',
    async (path) => {
      mocks.getTwoFactorEnrollmentState.mockResolvedValue({
        enabled: true,
        hasVerifiedFactor: true,
      });

      await expectTwoFactorRequired(() =>
        enforceTwoFactorSessionGate({ context: { path }, db, userId: 'u1' }),
      );
    },
  );

  it('allows a TOTP-enabled OAuth callback (SSO policy)', async () => {
    mocks.getTwoFactorEnrollmentState.mockResolvedValue({
      enabled: true,
      hasVerifiedFactor: true,
    });

    await enforceTwoFactorSessionGate({
      context: { path: '/oauth2/callback/dingtalk' },
      db,
      userId: 'u1',
    });
  });
});
