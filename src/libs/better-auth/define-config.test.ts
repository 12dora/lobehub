import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn((options) => options),
  ensureDefaultPlatformUserRole: vi.fn(async () => undefined),
  enforcePlatformOidcGroupRoleMappingForUserAccounts: vi.fn(async () => undefined),
  enforceTwoFactorSessionGate: vi.fn(async () => undefined),
  EnvHttpProxyAgent: vi.fn((options) => ({ options })),
  initUser: vi.fn(async () => undefined),
  setGlobalDispatcher: vi.fn(),
  withTwoFactorChallengedPaths: vi.fn((plugin) => plugin),
}));

vi.mock('@better-auth/expo', () => ({
  expo: vi.fn(() => ({ id: 'expo' })),
}));

vi.mock('@better-auth/passkey', () => ({
  passkey: vi.fn(() => ({ id: 'passkey' })),
}));

vi.mock('@lobechat/database', () => ({
  createNanoId: vi.fn(() => vi.fn(() => 'generated-id')),
  idGenerator: vi.fn(() => 'generated-user-id'),
  serverDB: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ accountId: 'idp-subject-1', providerId: 'corp-oidc' }]),
      })),
    })),
  },
}));

vi.mock('@lobechat/database/schemas', () => ({
  account: {
    accountId: 'account_id',
    providerId: 'provider_id',
    userId: 'user_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
  },
}));

vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: vi.fn(() => ({ id: 'drizzle-adapter' })),
}));

vi.mock('better-auth/crypto', () => ({
  verifyPassword: vi.fn(),
}));

vi.mock('better-auth/minimal', () => ({
  betterAuth: mocks.betterAuth,
}));

vi.mock('better-auth/plugins', () => ({
  admin: vi.fn(() => ({ id: 'admin' })),
  emailOTP: vi.fn(() => ({ id: 'email-otp' })),
  genericOAuth: vi.fn(() => ({ id: 'generic-oauth' })),
  magicLink: vi.fn(() => ({ id: 'magic-link' })),
  twoFactor: vi.fn(() => ({ id: 'two-factor' })),
}));

vi.mock('undici', () => ({
  EnvHttpProxyAgent: mocks.EnvHttpProxyAgent,
  setGlobalDispatcher: mocks.setGlobalDispatcher,
}));

vi.mock('@/envs/app', () => ({
  appEnv: {
    APP_URL: 'https://example.com',
  },
}));

const authEnvMock = vi.hoisted(() => ({
  AUTH_COOKIE_PREFIX: undefined as string | undefined,
  AUTH_DISABLE_EMAIL_PASSWORD: false,
  AUTH_EMAIL_VERIFICATION: true,
  AUTH_ENABLE_MAGIC_LINK: false,
  AUTH_SECRET: 'test-secret',
  AUTH_SSO_PROVIDERS: '',
}));

vi.mock('@/envs/auth', () => ({
  authEnv: authEnvMock,
}));

vi.mock('@/libs/better-auth/email-templates', () => ({
  getChangeEmailVerificationTemplate: vi.fn(() => ({})),
  getMagicLinkEmailTemplate: vi.fn(() => ({})),
  getResetPasswordEmailTemplate: vi.fn(() => ({})),
  getVerificationEmailTemplate: vi.fn(() => ({})),
  getVerificationOTPEmailTemplate: vi.fn(() => ({})),
}));

vi.mock('@/libs/better-auth/plugins/email-whitelist', () => ({
  emailWhitelist: vi.fn(() => ({ id: 'email-whitelist' })),
}));

vi.mock('@/libs/better-auth/plugins/registration-guard', () => ({
  registrationGuard: vi.fn(() => ({ id: 'registration-guard' })),
}));

vi.mock('@/libs/better-auth/two-factor/session-gate', () => ({
  enforceTwoFactorSessionGate: mocks.enforceTwoFactorSessionGate,
}));

vi.mock('@/libs/better-auth/two-factor/attempt-limit', () => ({
  twoFactorAttemptLimit: vi.fn(() => ({ id: 'two-factor-attempt-limit' })),
}));

vi.mock('@/libs/better-auth/two-factor/passkey-user-verification', () => ({
  assertPasskeyUserVerified: vi.fn(),
}));

vi.mock('@/libs/better-auth/two-factor/with-challenged-paths', () => ({
  EXTRA_2FA_CHALLENGE_PATHS: new Set(['/magic-link/verify', '/sign-in/email-otp', '/verify-email']),
  withTwoFactorChallengedPaths: mocks.withTwoFactorChallengedPaths,
}));

vi.mock('@/database/models/platform/ensureDefaultRole', () => ({
  ensureDefaultPlatformUserRole: mocks.ensureDefaultPlatformUserRole,
}));

vi.mock('@/libs/better-auth/sso', () => ({
  initBetterAuthSSOProviders: vi.fn(() => ({
    genericOAuthProviders: [],
    socialProviders: {},
  })),
}));

vi.mock('@/libs/better-auth/sso/platformIdentityProvider', () => ({
  buildPlatformIdentityProvider: vi.fn((provider) => ({ providerId: provider.providerKey })),
  enforcePlatformOidcGroupRoleMappingForUserAccounts:
    mocks.enforcePlatformOidcGroupRoleMappingForUserAccounts,
}));

vi.mock('@/libs/better-auth/sso/platformIdentityProviderState', () => ({
  platformIdentityProviderState: vi.fn((providerIds) => ({
    id: 'platform-identity-provider-state',
    providerIds,
  })),
}));

vi.mock('@/libs/better-auth/utils/config', () => ({
  createSecondaryStorage: vi.fn(() => ({ id: 'secondary-storage' })),
  getTrustedOrigins: vi.fn(() => ['https://example.com']),
}));

vi.mock('@/libs/better-auth/utils/server', () => ({
  parseSSOProviders: vi.fn(() => []),
}));

vi.mock('@/server/services/email', () => ({
  EmailService: Object.assign(vi.fn(), {
    create: vi.fn(async () => ({
      sendBrandedMail: vi.fn(),
      sendMail: vi.fn(),
    })),
  }),
}));

vi.mock('@/server/enterprise/services/infraSettings/snapshot', () => ({
  getInfraSnapshot: vi.fn(async () => ({
    loadedAt: Date.now(),
    mail: { kind: 'unconfigured', source: 'env' },
    objectStorage: { kind: 'unconfigured', previewUrlExpireIn: 7200, source: 'env' },
  })),
  peekInfraSnapshot: vi.fn(() => null),
}));

vi.mock('@/server/services/user', () => ({
  UserService: vi.fn().mockImplementation(() => ({
    initUser: mocks.initUser,
  })),
}));

describe('defineConfig', { timeout: 15_000 }, () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authEnvMock.AUTH_COOKIE_PREFIX = undefined;
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should revoke existing sessions after password reset by default', async () => {
    const { defineConfig } = await import('./define-config');

    await defineConfig({ plugins: [] });

    expect(mocks.betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAndPassword: expect.objectContaining({
          revokeSessionsOnPasswordReset: true,
        }),
      }),
    );
  });

  it('registers both second factors and throttles the guessable ones', async () => {
    const { defineConfig } = await import('./define-config');
    const { twoFactor } = await import('better-auth/plugins');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0];
    expect(options.plugins).toContainEqual({ id: 'two-factor' });
    expect(options.plugins).toContainEqual({ id: 'passkey' });
    expect(mocks.withTwoFactorChallengedPaths).toHaveBeenCalledWith({ id: 'two-factor' });

    // A half-finished enrolment must not count as a factor.
    expect(twoFactor).toHaveBeenCalledWith(
      expect.objectContaining({ skipVerificationOnEnable: false }),
    );

    // A 6-digit code and a backup code are both small enough to brute-force unthrottled.
    expect(options.rateLimit.customRules).toMatchObject({
      '/two-factor/verify-backup-code': { max: 5, window: 60 },
      '/two-factor/verify-totp': { max: 5, window: 60 },
    });
  });

  it('stores OAuth state in the shared database for one-time callback consumption', async () => {
    const { defineConfig } = await import('./define-config');

    await defineConfig({ plugins: [] });

    expect(mocks.betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ storeStateStrategy: 'database' }),
      }),
    );
  });

  it('keeps kinds that cannot assert a verified email out of trustedProviders', async () => {
    const { defineConfig } = await import('./define-config');

    await defineConfig(
      { plugins: [] },
      {
        databaseProviders: [
          { enabled: true, providerKey: 'corp-oidc', type: 'authentik' } as never,
          { enabled: true, providerKey: 'dingtalk', type: 'dingtalk' } as never,
        ],
        providerIds: ['corp-oidc', 'dingtalk'],
      },
    );

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0];
    // Visible on the sign-in page…
    expect(options.plugins).toContainEqual({
      id: 'platform-identity-provider-state',
      providerIds: ['corp-oidc', 'dingtalk'],
    });
    // …but never trusted for implicit account linking: a trusted provider may attach its
    // identity to an existing account that merely shares an email address.
    expect(options.account.accountLinking.trustedProviders).toEqual(['corp-oidc']);
  });

  it('registers platform state binding without changing global verification storage', async () => {
    const { defineConfig } = await import('./define-config');

    await defineConfig({ plugins: [] });
    expect(mocks.betterAuth.mock.calls.at(-1)?.[0].verification).toBeUndefined();

    await defineConfig(
      { plugins: [] },
      {
        databaseProviders: [{ providerKey: 'corp-oidc' } as never],
        providerIds: ['corp-oidc'],
      },
    );

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0];
    expect(options.verification).toBeUndefined();
    expect(options.plugins).toContainEqual({
      id: 'platform-identity-provider-state',
      providerIds: ['corp-oidc'],
    });
  });

  it('keeps trusted DingTalk fields out of request input and session output', async () => {
    const { defineConfig } = await import('./define-config');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0];
    expect(options.user.additionalFields).toMatchObject({
      dingtalkTitle: {
        input: false,
        required: false,
        returned: false,
        type: 'string',
      },
      dingtalkUserId: {
        input: false,
        required: false,
        returned: false,
        type: 'string',
      },
    });
  });

  it('omits advanced.cookiePrefix when AUTH_COOKIE_PREFIX is unset (default cookie names)', async () => {
    const { defineConfig } = await import('./define-config');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0];
    expect(options.advanced).not.toHaveProperty('cookiePrefix');
  });

  it('namespaces cookies via advanced.cookiePrefix when AUTH_COOKIE_PREFIX is set', async () => {
    authEnvMock.AUTH_COOKIE_PREFIX = 'aihub-3011';
    const { defineConfig } = await import('./define-config');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0];
    expect(options.advanced.cookiePrefix).toBe('aihub-3011');
  });

  it('configures a 7-day sliding session with compact cookie cache and DB persistence', async () => {
    const { defineConfig } = await import('./define-config');
    const { SESSION_COOKIE_CACHE_MAX_AGE_SECONDS, SESSION_COOKIE_CACHE_STRATEGY } =
      await import('./session-cookie-cache');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0];
    expect(options.session).toEqual({
      cookieCache: {
        enabled: true,
        maxAge: SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
        strategy: SESSION_COOKIE_CACHE_STRATEGY,
      },
      expiresIn: 60 * 60 * 24 * 7,
      preserveSessionInDatabase: true,
      storeSessionInDatabase: true,
      updateAge: 60 * 60 * 12,
    });
    expect(SESSION_COOKIE_CACHE_MAX_AGE_SECONDS).toBe(5 * 60);
    expect(SESSION_COOKIE_CACHE_STRATEGY).toBe('compact');
  });

  it('should respect NO_PROXY when configuring the development proxy dispatcher', async () => {
    process.env = {
      ...process.env,
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NODE_ENV: 'development',
      NO_PROXY: 'example.com,localhost',
    };

    await import('./define-config');

    expect(mocks.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: 'example.com,localhost,127.0.0.1,[::1]',
    });
    expect(mocks.setGlobalDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          noProxy: 'example.com,localhost,127.0.0.1,[::1]',
        }),
      }),
    );
  });

  it('should preserve NO_PROXY wildcard semantics', async () => {
    const { mergeLocalNoProxy } = await import('./define-config');

    expect(mergeLocalNoProxy('*')).toBe('*');
  });

  it('grants default platform_user via user.create.after hook', async () => {
    const { defineConfig } = await import('./define-config');
    const { serverDB } = await import('@lobechat/database');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0] as {
      databaseHooks: {
        user: { create: { after: (user: Record<string, unknown>) => Promise<void> } };
      };
    };
    const user = {
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      email: 'new@example.com',
      id: 'user_new_signup',
      username: 'newuser',
    };

    await options.databaseHooks.user.create.after(user);

    expect(mocks.initUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@example.com',
        id: 'user_new_signup',
        username: 'newuser',
      }),
    );
    expect(mocks.ensureDefaultPlatformUserRole).toHaveBeenCalledWith(serverDB, 'user_new_signup');
  });

  it('repairs default platform_user on session.create.before (idempotent)', async () => {
    const { defineConfig } = await import('./define-config');
    const { serverDB } = await import('@lobechat/database');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0] as {
      databaseHooks: {
        session: {
          create: {
            before: (
              session: Record<string, unknown>,
            ) => Promise<false | { data: Record<string, unknown> }>;
          };
        };
      };
    };

    mocks.ensureDefaultPlatformUserRole.mockClear();
    const allowed = await options.databaseHooks.session.create.before({ userId: 'user_repair_1' });
    expect(allowed).toEqual({ data: { userId: 'user_repair_1' } });
    expect(mocks.ensureDefaultPlatformUserRole).toHaveBeenCalledWith(serverDB, 'user_repair_1');
  });

  it('enforces IdP group→role mapping on session.create.before (fail-closed)', async () => {
    const { defineConfig } = await import('./define-config');
    const { serverDB } = await import('@lobechat/database');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0] as {
      databaseHooks: {
        session: {
          create: {
            before: (
              session: Record<string, unknown>,
            ) => Promise<false | { data: Record<string, unknown> }>;
          };
        };
      };
    };

    const allowed = await options.databaseHooks.session.create.before({ userId: 'user_sso_1' });
    expect(allowed).toEqual({ data: { userId: 'user_sso_1' } });
    expect(mocks.enforcePlatformOidcGroupRoleMappingForUserAccounts).toHaveBeenCalledWith({
      accounts: [{ accountId: 'idp-subject-1', providerId: 'corp-oidc' }],
      db: serverDB,
      userId: 'user_sso_1',
    });
  });

  it('denies session creation when IdP group→role reconciliation fails', async () => {
    const { defineConfig } = await import('./define-config');

    mocks.enforcePlatformOidcGroupRoleMappingForUserAccounts.mockRejectedValueOnce(
      new Error('simulated demotion outage'),
    );

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0] as {
      databaseHooks: {
        session: {
          create: {
            before: (
              session: Record<string, unknown>,
            ) => Promise<false | { data: Record<string, unknown> }>;
          };
        };
      };
    };

    await expect(
      options.databaseHooks.session.create.before({ userId: 'user_sso_1' }),
    ).resolves.toBe(false);
  });

  it('runs the 2FA session gate on session.create.before', async () => {
    const { defineConfig } = await import('./define-config');
    const { serverDB } = await import('@lobechat/database');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0] as {
      databaseHooks: {
        session: {
          create: {
            before: (
              session: Record<string, unknown>,
              context?: { path?: string },
            ) => Promise<false | { data: Record<string, unknown> }>;
          };
        };
      };
    };

    const context = { path: '/callback/google' };
    await options.databaseHooks.session.create.before({ userId: 'user_2fa_1' }, context);

    expect(mocks.enforceTwoFactorSessionGate).toHaveBeenCalledWith({
      context,
      db: serverDB,
      userId: 'user_2fa_1',
    });
  });

  it('requires passkey user verification and registers the atomic 2FA counter', async () => {
    const { defineConfig } = await import('./define-config');
    const { passkey } = await import('@better-auth/passkey');
    const { twoFactorAttemptLimit } = await import('@/libs/better-auth/two-factor/attempt-limit');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0];
    expect(options.plugins).toContainEqual({ id: 'two-factor-attempt-limit' });
    expect(twoFactorAttemptLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        increment: undefined,
      }),
    );

    expect(passkey).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatorSelection: { userVerification: 'required' },
        authentication: expect.objectContaining({
          afterVerification: expect.any(Function),
        }),
      }),
    );

    const { assertPasskeyUserVerified } =
      await import('@/libs/better-auth/two-factor/passkey-user-verification');
    const passkeyOptions = vi.mocked(passkey).mock.calls.at(-1)?.[0] as {
      authentication: { afterVerification: (args: { verification: unknown }) => Promise<void> };
    };
    const verification = { authenticationInfo: { userVerified: false } };
    await passkeyOptions.authentication.afterVerification({ verification });
    expect(assertPasskeyUserVerified).toHaveBeenCalledWith(verification);
  });
});
