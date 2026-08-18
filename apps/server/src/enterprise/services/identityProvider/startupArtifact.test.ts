import { describe, expect, it, vi } from 'vitest';

import {
  commitIdentityProviderStartupSnapshot,
  getIdentityProviderPublicArtifact,
  getIdentityProviderRuntimeArtifact,
  getIdentityProviderStartupArtifactHealth,
  getInitializedIdentityProviderPublicArtifact,
  markIdentityProviderStartupLoading,
  resetIdentityProviderStartupArtifactForTest,
} from './startupArtifact';

describe('identity provider startup artifact', () => {
  it('exposes explicit uninitialized/loading fallbacks without loader work', () => {
    resetIdentityProviderStartupArtifactForTest();
    expect(getIdentityProviderPublicArtifact({ AUTH_SSO_PROVIDERS: 'google' })).toMatchObject({
      phase: 'uninitialized',
      providers: [{ icon: null, id: 'google', label: null, order: 0, providerKey: 'google' }],
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
          dingtalkAllowedCorps: [],
          clientSecret: 'must-not-be-public',
          displayName: 'Work',
          domainAllowlist: [],
          enabled: true,
          groupRoleMapping: {},
          icon: null,
          issuer: 'https://login.example.test',
          oidcMetadata: {
            authorizationEndpoint: 'https://login.example.test/authorize',
            authorizationResponseIssParameterSupported: false,
            codeChallengeMethodsSupported: ['S256'],
            idTokenSigningAlgValuesSupported: ['RS256'],
            issuer: 'https://login.example.test',
            jwksUri: 'https://login.example.test/jwks',
            responseTypesSupported: ['code'],
            scopesSupported: ['openid'],
            subjectTypesSupported: ['public'],
            tokenEndpoint: 'https://login.example.test/token',
            tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
            userinfoEndpoint: 'https://login.example.test/userinfo',
          },
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

    const publicArtifact = getIdentityProviderPublicArtifact();
    expect(publicArtifact.providers).toEqual([
      { icon: null, id: 'work', label: 'Work', order: 0, providerKey: 'work' },
    ]);
    expect(JSON.stringify(publicArtifact)).not.toContain('must-not-be-public');
    expect(getIdentityProviderRuntimeArtifact().databaseProviders[0]?.clientSecret).toBe(
      'must-not-be-public',
    );
  });

  it('shares the committed artifact across independently evaluated server chunks', async () => {
    resetIdentityProviderStartupArtifactForTest();
    commitIdentityProviderStartupSnapshot({
      databaseProviders: [],
      generation: 'cross-chunk-generation',
      health: 'healthy',
      identityRevision: null,
      lastError: null,
      loadedAt: new Date(),
      providerIds: ['work'],
      source: 'environment',
    });

    vi.resetModules();
    const isolatedChunk = await import('./startupArtifact');
    expect(isolatedChunk.getInitializedIdentityProviderPublicArtifact()).toMatchObject({
      generation: 'cross-chunk-generation',
      phase: 'ready',
      providerIds: ['work'],
    });
    isolatedChunk.resetIdentityProviderStartupArtifactForTest();
  });

  it('includes providerIds on the process health DTO', () => {
    resetIdentityProviderStartupArtifactForTest();
    expect(getIdentityProviderStartupArtifactHealth()).toBeNull();
    commitIdentityProviderStartupSnapshot({
      databaseProviders: [],
      generation: 'generation',
      health: 'healthy',
      identityRevision: 'a'.repeat(64),
      lastError: null,
      loadedAt: new Date(),
      providerIds: ['work'],
      source: 'database',
    });
    expect(getIdentityProviderStartupArtifactHealth()).toMatchObject({
      providerIds: ['work'],
      source: 'database',
    });
  });
});
