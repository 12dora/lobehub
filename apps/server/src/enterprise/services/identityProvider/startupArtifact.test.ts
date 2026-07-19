import { describe, expect, it } from 'vitest';

import {
  commitIdentityProviderStartupSnapshot,
  getIdentityProviderPublicArtifact,
  getIdentityProviderRuntimeArtifact,
  getInitializedIdentityProviderPublicArtifact,
  markIdentityProviderStartupLoading,
  resetIdentityProviderStartupArtifactForTest,
} from './startupArtifact';

describe('identity provider startup artifact', () => {
  it('exposes explicit uninitialized/loading fallbacks without loader work', () => {
    resetIdentityProviderStartupArtifactForTest();
    expect(getIdentityProviderPublicArtifact({ AUTH_SSO_PROVIDERS: 'google' })).toMatchObject({
      phase: 'uninitialized',
      providerIds: ['google'],
    });
    expect(() => getInitializedIdentityProviderPublicArtifact()).toThrow(
      'PLATFORM_IDENTITY_PROVIDER_STARTUP_NOT_INITIALIZED',
    );
    markIdentityProviderStartupLoading();
    expect(getIdentityProviderRuntimeArtifact({ AUTH_SSO_PROVIDERS: 'google' })).toMatchObject({
      databaseProviders: [],
      phase: 'loading',
      providerIds: ['google'],
    });
  });

  it('publishes secret-free public state separately from the runtime artifact', () => {
    resetIdentityProviderStartupArtifactForTest();
    commitIdentityProviderStartupSnapshot({
      databaseProviders: [
        {
          autoProvision: true,
          buttonLabel: 'Work',
          claimMapping: {
            dingtalkTitle: [],
            dingtalkUserId: [],
            email: ['email'],
            name: ['name'],
            picture: [],
            subject: ['sub'],
          },
          clientId: 'client',
          clientSecret: 'must-not-be-public',
          displayName: 'Work',
          domainAllowlist: [],
          enabled: true,
          groupRoleMapping: {},
          icon: null,
          issuer: 'https://login.example.test',
          providerKey: 'work',
          revision: 1,
          scopes: ['openid'],
          secretFingerprint: 'a'.repeat(64),
          type: 'generic_oidc',
          usePkce: true,
        },
      ],
      generation: 'generation',
      health: 'healthy',
      identityRevision: 'a'.repeat(64),
      lastError: null,
      loadedAt: new Date(),
      providerIds: ['work'],
      source: 'database',
    });

    expect(JSON.stringify(getIdentityProviderPublicArtifact())).not.toContain('must-not-be-public');
    expect(getIdentityProviderRuntimeArtifact().databaseProviders[0]?.clientSecret).toBe(
      'must-not-be-public',
    );
  });
});
