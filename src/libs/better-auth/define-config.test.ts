import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn((options) => options),
  ensureDefaultPlatformUserRole: vi.fn(async () => undefined),
  enforcePlatformOidcGroupRoleMappingForUserAccounts: vi.fn(async () => undefined),
  enforcePlatformOidcGroupRoleMappingOnLogin: vi.fn(async () => undefined),
  EnvHttpProxyAgent: vi.fn((options) => ({ options })),
  initUser: vi.fn(async () => undefined),
  setGlobalDispatcher: vi.fn(),
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
  enforcePlatformOidcGroupRoleMappingOnLogin: mocks.enforcePlatformOidcGroupRoleMappingOnLogin,
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
  EmailService: vi.fn(),
}));

vi.mock('@/server/services/user', () => ({
  UserService: vi.fn().mockImplementation(() => ({
    initUser: mocks.initUser,
  })),
}));

describe('defineConfig', () => {
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

  it('stores OAuth state in the shared database for one-time callback consumption', async () => {
    const { defineConfig } = await import('./define-config');

    await defineConfig({ plugins: [] });

    expect(mocks.betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ storeStateStrategy: 'database' }),
      }),
    );
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

  it('enforces IdP group→role mapping on account create/update and session create', async () => {
    const { defineConfig } = await import('./define-config');
    const { serverDB } = await import('@lobechat/database');

    await defineConfig({ plugins: [] });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0] as {
      databaseHooks: {
        account: {
          create: { after: (account: Record<string, unknown>) => Promise<void> };
          update: { after: (account: Record<string, unknown>) => Promise<void> };
        };
        session: {
          create: { after: (session: Record<string, unknown>) => Promise<void> };
        };
      };
    };

    const account = {
      accountId: 'idp-subject-1',
      providerId: 'corp-oidc',
      userId: 'user_sso_1',
    };
    await options.databaseHooks.account.create.after(account);
    expect(mocks.enforcePlatformOidcGroupRoleMappingOnLogin).toHaveBeenCalledWith({
      accountId: 'idp-subject-1',
      db: serverDB,
      providerId: 'corp-oidc',
      userId: 'user_sso_1',
    });

    mocks.enforcePlatformOidcGroupRoleMappingOnLogin.mockClear();
    await options.databaseHooks.account.update.after(account);
    expect(mocks.enforcePlatformOidcGroupRoleMappingOnLogin).toHaveBeenCalledWith({
      accountId: 'idp-subject-1',
      db: serverDB,
      providerId: 'corp-oidc',
      userId: 'user_sso_1',
    });

    await options.databaseHooks.session.create.after({ userId: 'user_sso_1' });
    expect(mocks.enforcePlatformOidcGroupRoleMappingForUserAccounts).toHaveBeenCalledWith({
      accounts: [{ accountId: 'idp-subject-1', providerId: 'corp-oidc' }],
      db: serverDB,
      userId: 'user_sso_1',
    });
  });
});
