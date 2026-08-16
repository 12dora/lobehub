// @vitest-environment node
import type { getOAuthState } from 'better-auth/api';
import { afterEach, describe, expect, it } from 'vitest';

import {
  resetIdentityProviderGroupRoleMappingRuntimeForTest,
  takeIdentityProviderGroupRoleMapping,
} from '@/server/enterprise/services/identityProvider/groupRoleMappingRuntime';

import {
  buildPlatformIdentityProvider,
  discardPlatformOidcGroupRoleMappingOnLoginFailure,
  enforcePlatformOidcGroupRoleMappingForUserAccounts,
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
  dingtalkAllowedCorps: [],
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
    // Discovery advertises RFC 9207 → require authorization-response iss at runtime.
    const rfc9207Provider = {
      ...provider,
      oidcMetadata: {
        ...provider.oidcMetadata,
        authorizationResponseIssParameterSupported: true,
      },
    } as const satisfies RuntimeIdentityProvider;
    expect(
      buildPlatformIdentityProvider(rfc9207Provider, 'https://app.example.test')
        .requireIssuerValidation,
    ).toBe(true);
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

  it('mapProfileToUser is pure — only flow-keyed stash is consumable on login', async () => {
    resetIdentityProviderGroupRoleMappingRuntimeForTest();
    const mappedProvider = {
      ...provider,
      groupRoleMapping: { engineering: 'ai_admin' },
    } as const satisfies RuntimeIdentityProvider;
    const config = buildPlatformIdentityProvider(mappedProvider, 'https://app.example.test');
    // mapProfileToUser must not leave a subject-only stash (password re-login attack).
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
    ).toBeNull();

    const { stashIdentityProviderGroupRoleMapping } =
      await import('@/server/enterprise/services/identityProvider/groupRoleMappingRuntime');
    // Production getUserInfo stashes once with the OAuth flow id.
    stashIdentityProviderGroupRoleMapping({
      flowId: 'oauth-state-1',
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
      providerKey: 'corp-oidc',
      subject: 'employee-1',
    });
    await expect(
      enforcePlatformOidcGroupRoleMappingOnLogin({
        accountId: 'employee-1',
        db: { __test: true } as never,
        flowId: 'oauth-state-1',
        providerId: 'corp-oidc',
        userId: 'user_local_1',
      }),
    ).rejects.toBeTruthy();
    // Pending entry is still consumed (one-shot) so it cannot be retried into a session.
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'oauth-state-1',
        providerKey: 'corp-oidc',
        subject: 'employee-1',
      }),
    ).toBeNull();
    // A later password session (no flow id) must not re-grant from leftover state.
    expect(
      takeIdentityProviderGroupRoleMapping({
        providerKey: 'corp-oidc',
        subject: 'employee-1',
      }),
    ).toBeNull();
  });

  it('discards pending group-role mapping on terminal login failure (identity/F9)', async () => {
    resetIdentityProviderGroupRoleMappingRuntimeForTest();
    const mappedProvider = {
      ...provider,
      groupRoleMapping: { engineering: 'ai_admin' },
    } as const satisfies RuntimeIdentityProvider;
    const config = buildPlatformIdentityProvider(mappedProvider, 'https://app.example.test');
    // Stash failed attempt with flow id (OAuth state) as production getUserInfo does.
    const { stashIdentityProviderGroupRoleMapping } =
      await import('@/server/enterprise/services/identityProvider/groupRoleMappingRuntime');
    stashIdentityProviderGroupRoleMapping({
      flowId: 'oauth-state-fail-1',
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
      providerKey: 'corp-oidc',
      subject: 'employee-fail',
    });
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'oauth-state-fail-1',
        providerKey: 'corp-oidc',
        subject: 'employee-fail',
      }),
    ).not.toBeNull();

    // Re-stash then terminal-failure discard scoped to this OAuth state.
    stashIdentityProviderGroupRoleMapping({
      flowId: 'oauth-state-fail-1',
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
      providerKey: 'corp-oidc',
      subject: 'employee-fail',
    });
    discardPlatformOidcGroupRoleMappingOnLoginFailure({
      flowId: 'oauth-state-fail-1',
      providerKey: 'corp-oidc',
    });
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'oauth-state-fail-1',
        providerKey: 'corp-oidc',
        subject: 'employee-fail',
      }),
    ).toBeNull();
    void config;
  });

  it('callback-hook failure cannot clear a concurrent successful login mapping (identity/F9)', async () => {
    resetIdentityProviderGroupRoleMappingRuntimeForTest();
    const { stashIdentityProviderGroupRoleMapping } =
      await import('@/server/enterprise/services/identityProvider/groupRoleMappingRuntime');
    const { platformIdentityProviderState } = await import('./platformIdentityProviderState');

    // Concurrent logins against the same provider: one will fail at callback, one succeed.
    stashIdentityProviderGroupRoleMapping({
      flowId: 'state-failed-login',
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
      providerKey: 'corp-oidc',
      subject: 'subject-failed',
    });
    stashIdentityProviderGroupRoleMapping({
      flowId: 'state-success-login',
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
      providerKey: 'corp-oidc',
      subject: 'subject-success',
    });

    const plugin = platformIdentityProviderState(['corp-oidc']);
    const afterHooks = plugin.hooks?.after ?? [];
    // Better Auth matchers compare the route pattern, not the resolved path.
    const callbackFailureHook = afterHooks.find((hook) =>
      hook.matcher({ path: '/oauth2/callback/:providerId' } as never),
    );
    expect(callbackFailureHook).toBeTruthy();

    // Production after-hook path: terminal failure without session cookie.
    await callbackFailureHook!.handler({
      context: {
        responseHeaders: new Headers({ location: 'https://app.example.test/login?error=1' }),
      },
      params: { providerId: 'corp-oidc' },
      query: { state: 'state-failed-login' },
    } as never);

    // Failed attempt discarded; concurrent success mapping retained for reconcile.
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'state-failed-login',
        providerKey: 'corp-oidc',
        subject: 'subject-failed',
      }),
    ).toBeNull();
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'state-success-login',
        providerKey: 'corp-oidc',
        subject: 'subject-success',
      }),
    ).toMatchObject({
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
    });

    // Subject-less / flow-less failure must not clear remaining provider mappings.
    stashIdentityProviderGroupRoleMapping({
      flowId: 'state-success-login-2',
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
      providerKey: 'corp-oidc',
      subject: 'subject-success-2',
    });
    discardPlatformOidcGroupRoleMappingOnLoginFailure({ providerKey: 'corp-oidc' });
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'state-success-login-2',
        providerKey: 'corp-oidc',
        subject: 'subject-success-2',
      }),
    ).not.toBeNull();
  });

  it('same-provider+same-subject: callback failure discards only the failed flow (identity/F9)', async () => {
    resetIdentityProviderGroupRoleMappingRuntimeForTest();
    const { stashIdentityProviderGroupRoleMapping, takeIdentityProviderGroupRoleMapping } =
      await import('@/server/enterprise/services/identityProvider/groupRoleMappingRuntime');
    const { platformIdentityProviderState } = await import('./platformIdentityProviderState');

    const subject = 'employee-same-subject';
    stashIdentityProviderGroupRoleMapping({
      flowId: 'state-older-fail',
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
      providerKey: 'corp-oidc',
      subject,
    });
    stashIdentityProviderGroupRoleMapping({
      flowId: 'state-newer-ok',
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
      providerKey: 'corp-oidc',
      subject,
    });

    const plugin = platformIdentityProviderState(['corp-oidc']);
    const afterHooks = plugin.hooks?.after ?? [];
    const callbackFailureHook = afterHooks.find((hook) =>
      hook.matcher({ path: '/oauth2/callback/:providerId' } as never),
    );
    expect(callbackFailureHook).toBeTruthy();

    await callbackFailureHook!.handler({
      context: {
        responseHeaders: new Headers({ location: 'https://app.example.test/login?error=1' }),
      },
      params: { providerId: 'corp-oidc' },
      query: { state: 'state-older-fail' },
    } as never);

    // Surviving same-subject flow mapping must still be consumable for reconcile.
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'state-newer-ok',
        providerKey: 'corp-oidc',
        subject,
      }),
    ).toMatchObject({
      groupRoleMapping: { engineering: 'ai_admin' },
      groups: ['engineering'],
    });
  });

  it('success session reconciles before concurrent fail cleanup: only own flow (identity/F9)', async () => {
    // Opposite ordering vs "fail cleanup first": successful session.create.before
    // runs while the failed flow's pending mapping still exists (and is newer).
    resetIdentityProviderGroupRoleMappingRuntimeForTest();
    const {
      pendingIdentityProviderGroupRoleMappingSizeForTest,
      stashIdentityProviderGroupRoleMapping,
      takeIdentityProviderGroupRoleMapping,
    } = await import('@/server/enterprise/services/identityProvider/groupRoleMappingRuntime');
    const { platformIdentityProviderState } = await import('./platformIdentityProviderState');

    const subject = 'employee-opposite-order';
    stashIdentityProviderGroupRoleMapping({
      flowId: 'state-success-flow',
      groupRoleMapping: { success_team: 'ai_admin' },
      groups: ['success_team'],
      providerKey: 'corp-oidc',
      subject,
    });
    stashIdentityProviderGroupRoleMapping({
      flowId: 'state-failed-newer-flow',
      groupRoleMapping: { failed_team: 'identity_admin' },
      groups: ['failed_team'],
      providerKey: 'corp-oidc',
      subject,
    });
    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(2);

    // Session path: resolve flow id the way production does (getOAuthState.oauthState).
    await enforcePlatformOidcGroupRoleMappingForUserAccounts({
      accounts: [{ accountId: subject, providerId: 'corp-oidc' }],
      db: { __test: true } as never,
      // apply will throw (fake db) after consuming — prove exact flow was taken first.
      flowId: 'state-success-flow',
      userId: 'user_local_opposite',
    }).catch(() => undefined);

    // Success flow consumed; failed flow's distinguishable mapping must remain.
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'state-success-flow',
        providerKey: 'corp-oidc',
        subject,
      }),
    ).toBeNull();
    expect(
      takeIdentityProviderGroupRoleMapping({
        flowId: 'state-failed-newer-flow',
        providerKey: 'corp-oidc',
        subject,
      }),
    ).toMatchObject({
      groupRoleMapping: { failed_team: 'identity_admin' },
      groups: ['failed_team'],
    });

    // Re-stash both for full ordering: success take-by-flow then fail cleanup.
    stashIdentityProviderGroupRoleMapping({
      flowId: 'state-success-flow',
      groupRoleMapping: { success_team: 'ai_admin' },
      groups: ['success_team'],
      providerKey: 'corp-oidc',
      subject,
    });
    stashIdentityProviderGroupRoleMapping({
      flowId: 'state-failed-newer-flow',
      groupRoleMapping: { failed_team: 'identity_admin' },
      groups: ['failed_team'],
      providerKey: 'corp-oidc',
      subject,
    });

    // Production session path also reads flow id from request OAuth state.
    await enforcePlatformOidcGroupRoleMappingForUserAccounts({
      accounts: [{ accountId: subject, providerId: 'corp-oidc' }],
      db: { __test: true } as never,
      readOAuthState: async () =>
        ({ oauthState: 'state-success-flow' }) as unknown as Awaited<
          ReturnType<typeof getOAuthState>
        >,
      userId: 'user_local_opposite',
    }).catch(() => undefined);

    const plugin = platformIdentityProviderState(['corp-oidc']);
    const afterHooks = plugin.hooks?.after ?? [];
    const callbackFailureHook = afterHooks.find((hook) =>
      hook.matcher({ path: '/oauth2/callback/:providerId' } as never),
    );
    await callbackFailureHook!.handler({
      context: {
        responseHeaders: new Headers({ location: 'https://app.example.test/login?error=1' }),
      },
      params: { providerId: 'corp-oidc' },
      query: { state: 'state-failed-newer-flow' },
    } as never);

    expect(pendingIdentityProviderGroupRoleMappingSizeForTest()).toBe(0);
  });
});

afterEach(() => {
  resetIdentityProviderGroupRoleMappingRuntimeForTest();
});
