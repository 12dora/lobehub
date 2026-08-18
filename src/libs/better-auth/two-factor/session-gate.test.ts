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
  getTwoFactorEnrollmentState: vi.fn(
    async (): Promise<{
      enabled: boolean;
      hasUnverifiedFactor: boolean;
      hasVerifiedFactor: boolean;
      userUpdatedAt: Date | null;
    }> => ({
      enabled: false,
      hasUnverifiedFactor: false,
      hasVerifiedFactor: false,
      userUpdatedAt: null,
    }),
  ),
}));

vi.mock('@better-auth/core/context', () => ({
  getCurrentAuthContext: (...args: unknown[]) => mocks.getCurrentAuthContext(...args),
}));

vi.mock('@/database/models/twoFactor', () => ({
  TWO_FACTOR_ORPHAN_GRACE_MS: 5 * 60 * 1000,
  clearOrphanedTwoFactorEnabled: mocks.clearOrphanedTwoFactorEnabled,
  getTwoFactorEnrollmentState: mocks.getTwoFactorEnrollmentState,
  isStaleTwoFactorOrphan: (
    state: {
      enabled: boolean;
      hasUnverifiedFactor: boolean;
      hasVerifiedFactor: boolean;
      userUpdatedAt: Date | null;
    },
    now = Date.now(),
  ) => {
    if (!state.enabled || state.hasVerifiedFactor) return false;
    if (!state.hasUnverifiedFactor) return true;
    if (!state.userUpdatedAt) return true;
    return now - state.userUpdatedAt.getTime() > 5 * 60 * 1000;
  },
}));

const enrolled = {
  enabled: true,
  hasUnverifiedFactor: false,
  hasVerifiedFactor: true,
  userUpdatedAt: new Date(),
};

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
    '/email-otp/verify-email',
    '/change-password',
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

  it.each([null, undefined])('allows a create with no HTTP path (%s)', (path) => {
    expect(isTwoFactorSessionPathAllowed(path)).toBe(true);
  });

  it.each([
    '',
    '/sign-in/social',
    '/sign-up/email',
    '/sign-in/magic-link',
    '/admin/impersonate-user',
  ])('refuses unknown or empty path %s', (path) => {
    expect(isTwoFactorSessionPathAllowed(path)).toBe(false);
  });
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
      hasUnverifiedFactor: false,
      hasVerifiedFactor: false,
      userUpdatedAt: null,
    });
    mocks.clearOrphanedTwoFactorEnabled.mockResolvedValue(false);
    mocks.getCurrentAuthContext.mockRejectedValue(new Error('no request context'));
  });

  it('does nothing when two-factor is off', async () => {
    await enforceTwoFactorSessionGate({ context: { path: '/callback/google' }, db, userId: 'u1' });
    expect(mocks.clearOrphanedTwoFactorEnabled).not.toHaveBeenCalled();
  });

  it('repairs a stale orphaned enabled flag and allows the session', async () => {
    mocks.getTwoFactorEnrollmentState.mockResolvedValue({
      enabled: true,
      hasUnverifiedFactor: true,
      hasVerifiedFactor: false,
      userUpdatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    await enforceTwoFactorSessionGate({ context: { path: '/callback/google' }, db, userId: 'u1' });

    expect(mocks.clearOrphanedTwoFactorEnabled).toHaveBeenCalledWith(db, 'u1');
  });

  it('does not repair a fresh unverified enrolment', async () => {
    mocks.getTwoFactorEnrollmentState.mockResolvedValue({
      enabled: true,
      hasUnverifiedFactor: true,
      hasVerifiedFactor: false,
      userUpdatedAt: new Date(),
    });

    await enforceTwoFactorSessionGate({
      context: { path: '/sign-in/email' },
      db,
      userId: 'u1',
    });

    expect(mocks.clearOrphanedTwoFactorEnabled).not.toHaveBeenCalled();
  });

  it('does not repair during /two-factor/verify-totp even if the row looks stale', async () => {
    mocks.getTwoFactorEnrollmentState.mockResolvedValue({
      enabled: true,
      hasUnverifiedFactor: true,
      hasVerifiedFactor: false,
      userUpdatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    await enforceTwoFactorSessionGate({
      context: { path: '/two-factor/verify-totp' },
      db,
      userId: 'u1',
    });

    expect(mocks.clearOrphanedTwoFactorEnabled).not.toHaveBeenCalled();
  });

  it.each([...TWO_FACTOR_SESSION_ALLOWED_PATHS])(
    'allows a TOTP-enabled user on %s',
    async (path) => {
      mocks.getTwoFactorEnrollmentState.mockResolvedValue(enrolled);

      await enforceTwoFactorSessionGate({ context: { path }, db, userId: 'u1' });
    },
  );

  it('allows a TOTP-enabled user when there is no HTTP path', async () => {
    mocks.getTwoFactorEnrollmentState.mockResolvedValue(enrolled);

    await enforceTwoFactorSessionGate({ db, userId: 'u1' });
  });

  it.each(['/sign-in/social', '/sign-up/email', '/admin/impersonate-user'])(
    'refuses a TOTP-enabled user on unknown path %s',
    async (path) => {
      mocks.getTwoFactorEnrollmentState.mockResolvedValue(enrolled);

      await expectTwoFactorRequired(() =>
        enforceTwoFactorSessionGate({ context: { path }, db, userId: 'u1' }),
      );
    },
  );

  it('allows a TOTP-enabled OAuth callback (SSO policy)', async () => {
    mocks.getTwoFactorEnrollmentState.mockResolvedValue(enrolled);

    await enforceTwoFactorSessionGate({
      context: { path: '/oauth2/callback/dingtalk' },
      db,
      userId: 'u1',
    });
  });
});
