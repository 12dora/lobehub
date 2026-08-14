import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ModelProviderCard } from '../types';
import {
  DEFAULT_MODEL_PROVIDER_LIST,
  isPersonalOAuthOnlyProvider,
  isProviderDisableBrowserRequest,
  isProviderOAuthDeviceFlow,
} from './index';

describe('model provider predicates', () => {
  const originalProviders = [...DEFAULT_MODEL_PROVIDER_LIST];

  const createProvider = (overrides: Partial<ModelProviderCard>): ModelProviderCard => ({
    chatModels: [],
    id: 'test-provider',
    name: 'Test Provider',
    settings: {},
    url: 'https://example.com',
    ...overrides,
  });

  beforeEach(() => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(
      createProvider({ id: 'root-disabled', disableBrowserRequest: true }),
      createProvider({ id: 'settings-disabled', settings: { disableBrowserRequest: true } }),
      createProvider({ id: 'oauth-provider', settings: { authType: 'oauthDeviceFlow' } }),
      createProvider({ id: 'enabled-provider' }),
    );
  });

  afterEach(() => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(...originalProviders);
  });

  it('returns true for providers with root-level disableBrowserRequest', () => {
    expect(isProviderDisableBrowserRequest('root-disabled')).toBe(true);
  });

  it('returns true for providers with settings.disableBrowserRequest', () => {
    expect(isProviderDisableBrowserRequest('settings-disabled')).toBe(true);
  });

  it('returns false for providers without disableBrowserRequest', () => {
    expect(isProviderDisableBrowserRequest('enabled-provider')).toBe(false);
  });

  it('returns false for unknown provider id', () => {
    expect(isProviderDisableBrowserRequest('not-exists')).toBe(false);
  });

  it('detects OAuth device flow providers', () => {
    expect(isProviderOAuthDeviceFlow('oauth-provider')).toBe(true);
    expect(isProviderOAuthDeviceFlow('enabled-provider')).toBe(false);
    expect(isProviderOAuthDeviceFlow('not-exists')).toBe(false);
    expect(isProviderOAuthDeviceFlow()).toBe(false);
  });

  it('detects personal-OAuth-only providers via the refresh-token grant', () => {
    DEFAULT_MODEL_PROVIDER_LIST.push(
      createProvider({
        id: 'personal-only',
        settings: {
          authType: 'oauthDeviceFlow',
          oauthDeviceFlow: {
            clientId: 'client',
            deviceCodeEndpoint: 'https://example.com/device',
            refreshTokenGrant: true,
            scopes: [],
            tokenEndpoint: 'https://example.com/oauth/token',
            tokenExchangeEndpoint: 'https://example.com/token',
          },
        },
      }),
    );
    expect(isPersonalOAuthOnlyProvider('personal-only')).toBe(true);
    // A device-flow provider without refreshTokenGrant stays platform-manageable.
    expect(isPersonalOAuthOnlyProvider('oauth-provider')).toBe(false);
    expect(isPersonalOAuthOnlyProvider('not-exists')).toBe(false);
    expect(isPersonalOAuthOnlyProvider()).toBe(false);
  });

  it('marks exactly chatgpt and supergrok as personal-OAuth-only in the real catalog', () => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(...originalProviders);
    const personalOnly = DEFAULT_MODEL_PROVIDER_LIST.filter((provider) =>
      isPersonalOAuthOnlyProvider(provider.id),
    )
      .map((provider) => provider.id)
      .sort();
    expect(personalOnly).toEqual(['chatgpt', 'supergrok']);
    // GitHub Copilot uses a device flow but exchanges a platform-storable token.
    expect(isPersonalOAuthOnlyProvider('githubcopilot')).toBe(false);
  });
});
