import { APIError } from 'better-auth/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PLATFORM_AUTH_SETTINGS,
  type PlatformAuthSettings,
} from '@/types/platform/authSettings';

import {
  enforceRegistrationPolicy,
  isSelfServiceSignupPath,
  isUserCreatePolicyExemptPath,
  loadRegistrationSettings,
  registrationGuard,
  SELF_SERVICE_REQUEST_PATHS,
  SELF_SERVICE_SIGNUP_PATHS,
  USER_CREATE_POLICY_EXEMPT_PATHS,
} from './registration-guard';

const mockGet = vi.fn();
const mockFindUserByEmail = vi.fn();
const mockGetServerDB = vi.fn(async () => ({}));
const mockGetCurrentAuthContext = vi.fn();

vi.mock('@better-auth/core/context', () => ({
  getCurrentAuthContext: (...args: unknown[]) => mockGetCurrentAuthContext(...args),
}));

vi.mock('@/database/server', () => ({
  getServerDB: () => mockGetServerDB(),
}));

vi.mock('@/database/models/platform', () => ({
  PlatformAuthSettingsModel: class {
    get = mockGet;
  },
}));

const settings = (patch: Partial<PlatformAuthSettings> = {}): PlatformAuthSettings => ({
  ...DEFAULT_PLATFORM_AUTH_SETTINGS,
  ...patch,
});

const expectApiError = async (
  fn: () => unknown | Promise<unknown>,
  code: string,
  status?: string,
) => {
  try {
    await fn();
    expect.unreachable('expected APIError');
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    const apiError = error as InstanceType<typeof APIError>;
    expect(apiError.body?.code).toBe(code);
    if (status) expect(apiError.status).toBe(status);
  }
};

/**
 * better-auth 1.6.15 createUser / createOAuthUser call sites for plugins registered
 * in define-config.ts. Keep in sync when adding auth plugins that can provision users.
 * Enforcement is deny-by-default; this list documents the create-capable surface.
 *
 * `/sign-in/social` (idToken / native): intentionally **policy-gated**, not OAuth-callback
 * exempt. Browser SSO uses the redirect flow (`/callback/*`, exempt). This repo always uses
 * redirect (`useSignIn.ts`); first-time native idToken SSO is rejected when
 * `openRegistration=false` — deliberate asymmetry vs browser provision.
 */
const BETTER_AUTH_CREATE_CAPABLE_ENDPOINTS = [
  { coveredBy: 'policy' as const, path: '/sign-up/email', selfServiceInventory: true },
  { coveredBy: 'policy' as const, path: '/magic-link/verify', selfServiceInventory: true },
  { coveredBy: 'policy' as const, path: '/sign-in/email-otp', selfServiceInventory: true },
  // Native/idToken path: policy on create, not listed as self-service signup middleware.
  { coveredBy: 'policy' as const, path: '/sign-in/social', selfServiceInventory: false },
  { coveredBy: 'exempt' as const, path: '/admin/create-user' },
  { coveredBy: 'exempt' as const, path: '/callback/platform-oidc-acme' },
  { coveredBy: 'exempt' as const, path: '/oauth2/callback/work' },
] as const;

describe('registration-guard helpers', () => {
  it('documents known self-service signup paths including email-otp', () => {
    expect(isSelfServiceSignupPath('/sign-up/email')).toBe(true);
    expect(isSelfServiceSignupPath('/magic-link/verify')).toBe(true);
    expect(isSelfServiceSignupPath('/sign-in/email-otp')).toBe(true);
    expect(isSelfServiceSignupPath('/sign-in/magic-link')).toBe(false);
    expect(isSelfServiceSignupPath('/admin/create-user')).toBe(false);
    expect(isSelfServiceSignupPath(undefined)).toBe(false);
    expect(SELF_SERVICE_SIGNUP_PATHS.has('/sign-in/email-otp')).toBe(true);
    expect(SELF_SERVICE_REQUEST_PATHS.has('/sign-in/magic-link')).toBe(true);
    expect(SELF_SERVICE_REQUEST_PATHS.has('/email-otp/send-verification-otp')).toBe(true);
  });

  it('exempts only admin create-user and OAuth callback path prefixes', () => {
    expect(isUserCreatePolicyExemptPath('/admin/create-user')).toBe(true);
    expect(isUserCreatePolicyExemptPath('/callback/platform-oidc-acme')).toBe(true);
    expect(isUserCreatePolicyExemptPath('/oauth2/callback/work')).toBe(true);
    expect(isUserCreatePolicyExemptPath('/sign-up/email')).toBe(false);
    expect(isUserCreatePolicyExemptPath('/sign-in/email-otp')).toBe(false);
    expect(isUserCreatePolicyExemptPath('/magic-link/verify')).toBe(false);
    expect(isUserCreatePolicyExemptPath('/unknown-plugin/create')).toBe(false);
    expect(USER_CREATE_POLICY_EXEMPT_PATHS.has('/admin/create-user')).toBe(true);
  });

  it('covers every known create-capable better-auth endpoint (deny-by-default class)', () => {
    for (const endpoint of BETTER_AUTH_CREATE_CAPABLE_ENDPOINTS) {
      if (endpoint.coveredBy === 'policy') {
        expect(isUserCreatePolicyExemptPath(endpoint.path)).toBe(false);
        // Known self-service create surface is inventory-only; /sign-in/social is
        // policy-gated without being a SELF_SERVICE_SIGNUP_PATHS member.
        if (endpoint.selfServiceInventory) {
          expect(SELF_SERVICE_SIGNUP_PATHS.has(endpoint.path)).toBe(true);
        } else {
          expect(SELF_SERVICE_SIGNUP_PATHS.has(endpoint.path)).toBe(false);
        }
      } else {
        expect(isUserCreatePolicyExemptPath(endpoint.path)).toBe(true);
      }
    }
  });

  it('enforceRegistrationPolicy rejects closed registration', () => {
    expect(() =>
      enforceRegistrationPolicy('user@example.com', settings({ openRegistration: false })),
    ).toThrow(APIError);
  });

  it('enforceRegistrationPolicy accepts open registration without allowlist', () => {
    expect(() =>
      enforceRegistrationPolicy('anyone@anywhere.test', settings({ openRegistration: true })),
    ).not.toThrow();
  });

  it('enforceRegistrationPolicy enforces exact and wildcard domain allowlist', () => {
    const closedDomain = settings({
      emailDomainAllowlist: ['example.com', '*.corp.example'],
      emailDomainAllowlistEnabled: true,
      openRegistration: true,
    });
    expect(() => enforceRegistrationPolicy('a@example.com', closedDomain)).not.toThrow();
    expect(() => enforceRegistrationPolicy('a@mail.corp.example', closedDomain)).not.toThrow();
    expect(() => enforceRegistrationPolicy('a@corp.example', closedDomain)).not.toThrow();
    expect(() => enforceRegistrationPolicy('a@outside.test', closedDomain)).toThrow(APIError);
    expect(() => enforceRegistrationPolicy('malformed-no-at', closedDomain)).toThrow(APIError);
  });
});

describe('loadRegistrationSettings', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGetServerDB.mockReset();
    mockGetServerDB.mockResolvedValue({});
  });

  it('returns settings from the model', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    await expect(loadRegistrationSettings()).resolves.toEqual(
      settings({ openRegistration: false }),
    );
  });

  it('fails closed with REGISTRATION_POLICY_UNAVAILABLE on read error', async () => {
    mockGet.mockRejectedValue(new TypeError('relation does not exist'));
    await expectApiError(
      () => loadRegistrationSettings(),
      'REGISTRATION_POLICY_UNAVAILABLE',
      'SERVICE_UNAVAILABLE',
    );
  });
});

describe('registrationGuard plugin', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGetServerDB.mockReset();
    mockGetServerDB.mockResolvedValue({});
    mockFindUserByEmail.mockReset();
    mockGetCurrentAuthContext.mockReset();
  });

  const getBeforeHook = () => {
    const plugin = registrationGuard();
    const hook = plugin.hooks?.before?.[0];
    if (!hook) throw new Error('missing before hook');
    return hook;
  };

  const getCreateBefore = () => {
    const plugin = registrationGuard();
    const initResult = plugin.init?.({} as never);
    if (!initResult || typeof initResult !== 'object' || initResult instanceof Promise) {
      throw new Error('expected sync registrationGuard.init result');
    }
    const createBefore = initResult.options?.databaseHooks?.user?.create?.before;
    if (!createBefore) throw new Error('missing databaseHooks.user.create.before');
    return createBefore;
  };

  const userInput = (email: string, name: string) => ({
    createdAt: new Date(0),
    email,
    emailVerified: false,
    id: `user-${email}`,
    name,
    updatedAt: new Date(0),
  });

  it('matcher covers sign-up, magic-link request, and email-otp send', () => {
    const { matcher } = getBeforeHook();
    expect(matcher({ path: '/sign-up/email' } as never)).toBe(true);
    expect(matcher({ path: '/sign-in/magic-link' } as never)).toBe(true);
    expect(matcher({ path: '/email-otp/send-verification-otp' } as never)).toBe(true);
    expect(matcher({ path: '/magic-link/verify' } as never)).toBe(false);
    expect(matcher({ path: '/sign-in/email-otp' } as never)).toBe(false);
    expect(matcher({ path: '/admin/create-user' } as never)).toBe(false);
  });

  it('rejects closed registration on /sign-up/email', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    const { handler } = getBeforeHook();
    await expectApiError(
      () =>
        handler({
          body: { email: 'new@example.com' },
          context: { internalAdapter: { findUserByEmail: mockFindUserByEmail } },
          path: '/sign-up/email',
        } as never),
      'REGISTRATION_CLOSED',
    );
  });

  it('rejects non-allowlisted email on /sign-up/email', async () => {
    mockGet.mockResolvedValue(
      settings({
        emailDomainAllowlist: ['example.com'],
        emailDomainAllowlistEnabled: true,
        openRegistration: true,
      }),
    );
    const { handler } = getBeforeHook();
    await expectApiError(
      () =>
        handler({
          body: { email: 'attacker@outside.test' },
          context: { internalAdapter: { findUserByEmail: mockFindUserByEmail } },
          path: '/sign-up/email',
        } as never),
      'EMAIL_NOT_ALLOWED',
    );
  });

  it('accepts allowlisted email on open registration', async () => {
    mockGet.mockResolvedValue(
      settings({
        emailDomainAllowlist: ['example.com'],
        emailDomainAllowlistEnabled: true,
        openRegistration: true,
      }),
    );
    const { handler } = getBeforeHook();
    await expect(
      handler({
        body: { email: 'user@example.com' },
        context: { internalAdapter: { findUserByEmail: mockFindUserByEmail } },
        path: '/sign-up/email',
      } as never),
    ).resolves.toBeUndefined();
  });

  it('fails closed when settings cannot be read during sign-up', async () => {
    mockGet.mockRejectedValue(new Error('db down'));
    const { handler } = getBeforeHook();
    await expectApiError(
      () =>
        handler({
          body: { email: 'user@example.com' },
          context: { internalAdapter: { findUserByEmail: mockFindUserByEmail } },
          path: '/sign-up/email',
        } as never),
      'REGISTRATION_POLICY_UNAVAILABLE',
      'SERVICE_UNAVAILABLE',
    );
  });

  it('allows existing-user magic-link sign-in when registration is closed', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    mockFindUserByEmail.mockResolvedValue({ user: { id: 'u1', email: 'old@example.com' } });
    const { handler } = getBeforeHook();
    await expect(
      handler({
        body: { email: 'old@example.com' },
        context: { internalAdapter: { findUserByEmail: mockFindUserByEmail } },
        path: '/sign-in/magic-link',
      } as never),
    ).resolves.toBeUndefined();
  });

  it('rejects first-time magic-link when registration is closed', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    mockFindUserByEmail.mockResolvedValue(null);
    const { handler } = getBeforeHook();
    await expectApiError(
      () =>
        handler({
          body: { email: 'new@outside.test' },
          context: { internalAdapter: { findUserByEmail: mockFindUserByEmail } },
          path: '/sign-in/magic-link',
        } as never),
      'REGISTRATION_CLOSED',
    );
  });

  it('allows existing-user email-otp send when registration is closed', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    mockFindUserByEmail.mockResolvedValue({ user: { id: 'u1', email: 'old@example.com' } });
    const { handler } = getBeforeHook();
    await expect(
      handler({
        body: { email: 'old@example.com', type: 'sign-in' },
        context: { internalAdapter: { findUserByEmail: mockFindUserByEmail } },
        path: '/email-otp/send-verification-otp',
      } as never),
    ).resolves.toBeUndefined();
  });

  it('rejects first-time email-otp send when registration is closed', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    mockFindUserByEmail.mockResolvedValue(null);
    const { handler } = getBeforeHook();
    await expectApiError(
      () =>
        handler({
          body: { email: 'attacker@outside.test', type: 'sign-in' },
          context: { internalAdapter: { findUserByEmail: mockFindUserByEmail } },
          path: '/email-otp/send-verification-otp',
        } as never),
      'REGISTRATION_CLOSED',
    );
  });

  it('databaseHooks blocks first-time magic-link verify createUser', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    const createBefore = getCreateBefore();
    await expectApiError(
      () =>
        createBefore(userInput('attacker@outside.test', 'A'), {
          path: '/magic-link/verify',
        } as never),
      'REGISTRATION_CLOSED',
    );
  });

  it('databaseHooks blocks /sign-in/email-otp createUser when registration is closed', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    const createBefore = getCreateBefore();
    await expectApiError(
      () =>
        createBefore(userInput('attacker@outside.test', 'A'), {
          path: '/sign-in/email-otp',
        } as never),
      'REGISTRATION_CLOSED',
    );
  });

  it('databaseHooks blocks unknown plugin create paths (deny-by-default)', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    const createBefore = getCreateBefore();
    await expectApiError(
      () =>
        createBefore(userInput('attacker@outside.test', 'A'), {
          path: '/future-plugin/auto-register',
        } as never),
      'REGISTRATION_CLOSED',
    );
    expect(mockGet).toHaveBeenCalled();
  });

  it('databaseHooks blocks /sign-up/email createUser under allowlist', async () => {
    mockGet.mockResolvedValue(
      settings({
        emailDomainAllowlist: ['example.com'],
        emailDomainAllowlistEnabled: true,
        openRegistration: true,
      }),
    );
    const createBefore = getCreateBefore();
    await expectApiError(
      () =>
        createBefore(userInput('attacker@outside.test', 'A'), {
          path: '/sign-up/email',
        } as never),
      'EMAIL_NOT_ALLOWED',
    );
  });

  it('databaseHooks never reaches create when settings read fails', async () => {
    mockGet.mockRejectedValue(new Error('settings unavailable'));
    const createBefore = getCreateBefore();
    await expectApiError(
      () => createBefore(userInput('user@example.com', 'A'), { path: '/sign-up/email' } as never),
      'REGISTRATION_POLICY_UNAVAILABLE',
      'SERVICE_UNAVAILABLE',
    );
  });

  it('databaseHooks leaves admin and SSO creates unaffected', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: false }));
    const createBefore = getCreateBefore();
    const adminUser = userInput('admin-created@x.test', 'A');
    const ssoUser = userInput('sso@x.test', 'S');
    const sso2User = userInput('sso2@x.test', 'S');
    const scriptUser = userInput('script@x.test', 'S');

    await expect(
      createBefore(adminUser, {
        path: '/admin/create-user',
      } as never),
    ).resolves.toEqual({ data: adminUser });

    await expect(
      createBefore(ssoUser, {
        path: '/callback/platform-oidc-acme',
      } as never),
    ).resolves.toEqual({ data: ssoUser });

    await expect(
      createBefore(sso2User, {
        path: '/oauth2/callback/work',
      } as never),
    ).resolves.toEqual({ data: sso2User });

    mockGetCurrentAuthContext.mockRejectedValue(new Error('no auth context'));
    await expect(createBefore(scriptUser, undefined as never)).resolves.toEqual({
      data: scriptUser,
    });

    expect(mockGet).not.toHaveBeenCalled();
  });

  it('databaseHooks accepts open self-service create', async () => {
    mockGet.mockResolvedValue(settings({ openRegistration: true }));
    const createBefore = getCreateBefore();
    const okUser = userInput('ok@example.com', 'Ok');
    await expect(createBefore(okUser, { path: '/sign-up/email' } as never)).resolves.toEqual({
      data: okUser,
    });
  });
});
