// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildPlatformIdentityProvider,
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
  providerKey: 'corp-oidc',
  revision: 4,
  scopes: ['openid', 'profile', 'email', 'dingtalk'],
  secretFingerprint: 'a'.repeat(64),
  type: 'authentik',
  usePkce: true,
} as const satisfies RuntimeIdentityProvider;

describe('platform identity provider Better Auth adapter', () => {
  it('uses stable provider identity, callback, PKCE, and mapped claims', async () => {
    const config = buildPlatformIdentityProvider(provider, 'https://app.example.test');
    expect(config).toMatchObject({
      clientId: 'client-id',
      discoveryUrl:
        'https://login.example.test/application/o/work/.well-known/openid-configuration',
      issuer: provider.issuer,
      pkce: true,
      providerId: 'corp-oidc',
      redirectURI: 'https://app.example.test/api/auth/oauth2/callback/corp-oidc',
      requireIssuerValidation: true,
    });
    expect(config).not.toHaveProperty('overrideUserInfo');
    expect(
      await config.mapProfileToUser!({
        avatar: 'https://cdn.example.test/ada.png',
        display_name: 'Ada',
        dingtalk_title: 'Engineering Manager',
        dingtalk_user_id: 'ding-user-1',
        employee_id: 'employee-1',
        mail: 'ada@example.test',
      }),
    ).toEqual({
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
    expect(
      config.mapProfileToUser!({
        employee_id: 'employee-2',
        mail: 'grace@example.test',
        preferred_username: 'grace',
      }),
    ).toEqual({
      dingtalkTitle: null,
      dingtalkUserId: null,
      email: 'grace@example.test',
      id: 'employee-2',
      image: undefined,
      name: 'grace',
    });
  });

  it('fails closed for missing identity claims or a disallowed email domain', async () => {
    const config = buildPlatformIdentityProvider(provider, 'https://app.example.test');
    await expect(
      Promise.resolve().then(() =>
        config.mapProfileToUser!({
          display_name: 'Ada',
          employee_id: 'employee-1',
          mail: 'ada@attacker.test',
        }),
      ),
    ).rejects.toThrow('PLATFORM_OIDC_CLAIM_VALIDATION_FAILED');
    await expect(
      Promise.resolve().then(() =>
        config.mapProfileToUser!({ display_name: 'Ada', mail: 'ada@example.test' }),
      ),
    ).rejects.toThrow('PLATFORM_OIDC_CLAIM_VALIDATION_FAILED');
    await expect(
      Promise.resolve().then(() =>
        config.mapProfileToUser!({
          display_name: 'Ada',
          employee_id: 'employee-1',
          mail: 'not-an-email',
        }),
      ),
    ).rejects.toThrow('PLATFORM_OIDC_CLAIM_VALIDATION_FAILED');
  });

  it('keeps the Authentik/EasyTrade DingTalk claim names stable', () => {
    expect(
      getStableDingTalkClaims(provider, {
        dingtalk_title: 'Engineering Manager',
        dingtalk_user_id: 'ding-user-1',
      }),
    ).toEqual({ dingtalkTitle: 'Engineering Manager', dingtalkUserId: 'ding-user-1' });
  });
});
