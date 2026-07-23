// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import {
  resetIdentityProviderGroupRoleMappingRuntimeForTest,
  takeIdentityProviderGroupRoleMapping,
} from '@/server/enterprise/services/identityProvider/groupRoleMappingRuntime';

import {
  buildPlatformIdentityProvider,
  enforcePlatformOidcGroupRoleMappingOnLogin,
  getStableDingTalkClaims,
  type RuntimeIdentityProvider,
} from './platformIdentityProvider';

const provider = {
  autoProvision: true,
  buttonLabel: 'Work login',
  claimMapping: {
    dingtalkTitle: ['dingtalk_title'],
    dingtalkUserId: ['dingtalk_user_id'],
    email: ['mail', 'email'],
    name: ['display_name', 'name'],
    picture: ['avatar', 'picture'],
    subject: ['employee_id', 'sub'],
  },
  clientId: 'client-id',
  clientSecret: 'fake-client-secret',
  displayName: 'Work',
  domainAllowlist: ['example.test'],
  enabled: true,
  groupRoleMapping: {},
  icon: null,
  issuer: 'https://login.example.test/application/o/work/',
  oidcMetadata: {
    authorizationEndpoint: 'https://login.example.test/application/o/authorize/',
    authorizationResponseIssParameterSupported: false,
    codeChallengeMethodsSupported: ['S256'],
    idTokenSigningAlgValuesSupported: ['RS256'],
    issuer: 'https://login.example.test/application/o/work/',
    jwksUri: 'https://login.example.test/application/o/work/jwks/',
    responseTypesSupported: ['code'],
    scopesSupported: ['openid', 'profile', 'email', 'dingtalk'],
    subjectTypesSupported: ['public'],
    tokenEndpoint: 'https://login.example.test/application/o/token/',
    tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
    userinfoEndpoint: 'https://login.example.test/application/o/userinfo/',
  },
  providerKey: 'corp-oidc',
  revision: 4,
  scopes: ['openid', 'profile', 'email', 'dingtalk'],
  secretFingerprint: 'a'.repeat(64),
  type: 'authentik',
  usePkce: true,
} as const satisfies RuntimeIdentityProvider;

describe('platform identity provider Better Auth adapter', () => {
  it('maps refreshed profile claims for subsequent logins (overrideUserInfo path)', async () => {
    const config = buildPlatformIdentityProvider(provider, 'https://app.example.test');
    expect(config.overrideUserInfo).toBe(true);
    const first = config.mapProfileToUser!({
      avatar: 'https://cdn.example.test/old.png',
      display_name: 'Ada',
      dingtalk_title: 'Engineer',
      dingtalk_user_id: 'ding-user-1',
      employee_id: 'employee-1',
      mail: 'ada@example.test',
    });
    const second = config.mapProfileToUser!({
      avatar: 'https://cdn.example.test/new.png',
      display_name: 'Ada Lovelace',
      dingtalk_title: 'Engineering Director',
      dingtalk_user_id: 'ding-user-1',
      employee_id: 'employee-1',
      mail: 'ada@example.test',
    });
    expect(first).toMatchObject({
      dingtalkTitle: 'Engineer',
      image: 'https://cdn.example.test/old.png',
      name: 'Ada',
    });
    expect(second).toMatchObject({
      dingtalkTitle: 'Engineering Director',
      image: 'https://cdn.example.test/new.png',
      name: 'Ada Lovelace',
    });
  });
  it('uses stable provider identity, callback, PKCE, and mapped claims', async () => {
    const config = buildPlatformIdentityProvider(provider, 'https://app.example.test');
    expect(config).toMatchObject({
      authorizationUrl: 'https://login.example.test/application/o/authorize/',
      clientId: 'client-id',
      issuer: provider.issuer,
      pkce: true,
      providerId: 'corp-oidc',
      redirectURI: 'https://app.example.test/api/auth/oauth2/callback/corp-oidc',
      // Authentik omits RFC 9207 `iss` on authorize response; id_token verification covers issuer.
      requireIssuerValidation: false,
    });
    expect(config.requireIssuerValidation).toBe(false);
    expect(config).not.toHaveProperty('discoveryUrl');
    expect(config.tokenUrl).toBe('https://platform-oidc-token.invalid/');
    expect(config.tokenUrl).not.toBe(provider.oidcMetadata.tokenEndpoint);
    expect(config.overrideUserInfo).toBe(true);
    const mapped = config.mapProfileToUser!({
      avatar: 'https://cdn.example.test/ada.png',
      display_name: 'Ada',
      dingtalk_title: 'Engineering Manager',
      dingtalk_user_id: 'ding-user-1',
      employee_id: 'employee-1',
      mail: 'ada@example.test',
    });
    expect(mapped).not.toBeInstanceOf(Promise);
    expect(mapped).toEqual({
      dingtalkTitle: 'Engineering Manager',
      dingtalkUserId: 'ding-user-1',
      email: 'ada@example.test',
      id: 'employee-1',
      image: 'https://cdn.example.test/ada.png',
      name: 'Ada',
    });
  });

  it('falls back to preferred_username and keeps absent optional claims nullable', async () => {
    const config = buildPlatformIdentityProvider(provider, 'https://app.example.test');
    const mapped = config.mapProfileToUser!({
      employee_id: 'employee-2',
      mail: 'grace@example.test',
      preferred_username: 'grace',
    });
    expect(mapped).not.toBeInstanceOf(Promise);
    expect(mapped).toEqual({
      dingtalkTitle: null,
      dingtalkUserId: null,
      email: 'grace@example.test',
      id: 'employee-2',
      image: undefined,
      name: 'grace',
    });
  });

  it('fails closed synchronously for missing identity claims or a disallowed email domain', () => {
    const config = buildPlatformIdentityProvider(provider, 'https://app.example.test');
    expect(() =>
      config.mapProfileToUser!({
        display_name: 'Ada',
        employee_id: 'employee-1',
        mail: 'ada@attacker.test',
      }),
    ).toThrow('PLATFORM_OIDC_CLAIM_VALIDATION_FAILED');
    expect(() =>
      config.mapProfileToUser!({ display_name: 'Ada', mail: 'ada@example.test' }),
    ).toThrow('PLATFORM_OIDC_CLAIM_VALIDATION_FAILED');
    expect(() =>
      config.mapProfileToUser!({
        display_name: 'Ada',
        employee_id: 'employee-1',
        mail: 'not-an-email',
      }),
    ).toThrow('PLATFORM_OIDC_CLAIM_VALIDATION_FAILED');
  });

  it('rethrows the original profile access error synchronously', () => {
    const config = buildPlatformIdentityProvider(provider, 'https://app.example.test');
    const originalError = new Error('PROFILE_ACCESS_FAILURE');
    const profile = new Proxy<Record<string, unknown>>(
      {},
      {
        get: () => {
          throw originalError;
        },
      },
    );

    let thrown: unknown;
    try {
      config.mapProfileToUser!(profile);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);
  });

  it('keeps the Authentik/EasyTrade DingTalk claim names stable', () => {
    expect(
      getStableDingTalkClaims(provider, {
        dingtalk_title: 'Engineering Manager',
        dingtalk_user_id: 'ding-user-1',
      }),
    ).toEqual({ dingtalkTitle: 'Engineering Manager', dingtalkUserId: 'ding-user-1' });
  });

  it('rejects runtime metadata whose issuer was substituted after discovery', () => {
    expect(() =>
      buildPlatformIdentityProvider(
        {
          ...provider,
          oidcMetadata: { ...provider.oidcMetadata, issuer: 'https://attacker.example.test' },
        },
        'https://app.example.test',
      ),
    ).toThrow('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  });

  it('stashes IdP groups on mapProfileToUser and login enforce consumes the pending mapping', async () => {
    resetIdentityProviderGroupRoleMappingRuntimeForTest();
    const mappedProvider = {
      ...provider,
      groupRoleMapping: { engineering: 'ai_admin' },
    } as const satisfies RuntimeIdentityProvider;
    const config = buildPlatformIdentityProvider(mappedProvider, 'https://app.example.test');
    config.mapProfileToUser!({
      display_name: 'Ada',
      employee_id: 'employee-1',
      groups: ['engineering'],
      mail: 'ada@example.test',
    });
    expect(
      takeIdentityProviderGroupRoleMapping({
        providerKey: 'corp-oidc',
        subject: 'employee-1',
      }),
    ).toMatchObject({
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
    });

    // Re-stash; enforceOnLogin takes pending (apply may no-op on fake db — non-blocking).
    config.mapProfileToUser!({
      display_name: 'Ada',
      employee_id: 'employee-1',
      groups: ['engineering'],
      mail: 'ada@example.test',
    });
    await enforcePlatformOidcGroupRoleMappingOnLogin({
      accountId: 'employee-1',
      db: { __test: true } as never,
      providerId: 'corp-oidc',
      userId: 'user_local_1',
    });
    expect(
      takeIdentityProviderGroupRoleMapping({
        providerKey: 'corp-oidc',
        subject: 'employee-1',
      }),
    ).toBeNull();
  });
});

afterEach(() => {
  resetIdentityProviderGroupRoleMappingRuntimeForTest();
});
