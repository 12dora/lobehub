import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ModelProviderCard } from '../types';
import { CreateAiProviderSchema } from '../types/aiProvider';
import {
  DEFAULT_MODEL_PROVIDER_LIST,
  getProviderOAuthGrantFlow,
  getProviderPastedCredentialKind,
  isProviderAccessTokenPasteAllowed,
  isProviderDisableBrowserRequest,
  isProviderNativeFileInput,
  isProviderOAuthDeviceFlow,
  isProviderWebSessionOnly,
  isRotatingRefreshOAuthProvider,
  isWebAppProvider,
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

  it('detects rotating-refresh OAuth providers via the refresh-token grant', () => {
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
    expect(isRotatingRefreshOAuthProvider('personal-only')).toBe(true);
    // A device-flow provider without refreshTokenGrant stays platform-manageable.
    expect(isRotatingRefreshOAuthProvider('oauth-provider')).toBe(false);
    expect(isRotatingRefreshOAuthProvider('not-exists')).toBe(false);
    expect(isRotatingRefreshOAuthProvider()).toBe(false);
  });

  it('reads the grant flow, defaulting to the device-code grant', () => {
    DEFAULT_MODEL_PROVIDER_LIST.push(
      createProvider({
        id: 'paste-provider',
        settings: {
          authType: 'oauthDeviceFlow',
          oauthDeviceFlow: {
            allowAccessTokenPaste: true,
            authorizationCode: {
              authorizeEndpoint: 'https://example.com/authorize',
              redirectUri: 'https://example.com/callback',
            },
            clientId: 'client',
            deviceCodeEndpoint: 'https://example.com/authorize',
            grantFlow: 'authorization_code_paste',
            scopes: [],
            tokenEndpoint: 'https://example.com/oauth/token',
          },
        },
      }),
    );

    expect(getProviderOAuthGrantFlow('paste-provider')).toBe('authorization_code_paste');
    // Every provider that predates the discriminator keeps the device-code behaviour.
    expect(getProviderOAuthGrantFlow('oauth-provider')).toBe('device_code');
    expect(getProviderOAuthGrantFlow('not-exists')).toBe('device_code');
    expect(getProviderOAuthGrantFlow()).toBe('device_code');

    expect(isProviderAccessTokenPasteAllowed('paste-provider')).toBe(true);
    expect(isProviderAccessTokenPasteAllowed('oauth-provider')).toBe(false);
    expect(isProviderAccessTokenPasteAllowed('not-exists')).toBe(false);
    expect(isProviderAccessTokenPasteAllowed()).toBe(false);

    expect(getProviderPastedCredentialKind('paste-provider')).toBe('accessToken');
    expect(getProviderPastedCredentialKind('oauth-provider')).toBe('accessToken');
    expect(getProviderPastedCredentialKind('not-exists')).toBe('accessToken');
    expect(getProviderPastedCredentialKind()).toBe('accessToken');

    // A paste-flow card that did not opt out of the authorization page keeps both routes.
    expect(isProviderWebSessionOnly('paste-provider')).toBe(false);
    expect(isProviderWebSessionOnly('oauth-provider')).toBe(false);
    expect(isProviderWebSessionOnly('not-exists')).toBe(false);
    expect(isProviderWebSessionOnly()).toBe(false);
  });

  it('detects native file input providers from the card settings', () => {
    DEFAULT_MODEL_PROVIDER_LIST.push(
      createProvider({ id: 'native-files', settings: { nativeFileInput: true } }),
      createProvider({ id: 'explicitly-off', settings: { nativeFileInput: false } }),
    );

    expect(isProviderNativeFileInput('native-files')).toBe(true);
    expect(isProviderNativeFileInput('explicitly-off')).toBe(false);
    expect(isProviderNativeFileInput('enabled-provider')).toBe(false);
    expect(isProviderNativeFileInput('not-exists')).toBe(false);
    expect(isProviderNativeFileInput()).toBe(false);
  });

  it('marks exactly chatgptweb as native file input in the real catalog', () => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(...originalProviders);

    const nativeFileProviders = DEFAULT_MODEL_PROVIDER_LIST.filter((provider) =>
      isProviderNativeFileInput(provider.id),
    ).map((provider) => provider.id);

    expect(nativeFileProviders).toEqual(['chatgptweb']);
    // Catalogs that advertise `abilities.files` on models but have no native
    // file part on the wire must stay on the `<files_info>` text injection.
    expect(isProviderNativeFileInput('opencodezen')).toBe(false);
    expect(isProviderNativeFileInput('openai')).toBe(false);
    expect(isProviderNativeFileInput('anthropic')).toBe(false);
  });

  it('detects webApp providers from the card settings', () => {
    DEFAULT_MODEL_PROVIDER_LIST.push(
      createProvider({ id: 'web-app', settings: { webApp: true } }),
      createProvider({ id: 'explicitly-off', settings: { webApp: false } }),
    );

    expect(isWebAppProvider('web-app')).toBe(true);
    expect(isWebAppProvider('explicitly-off')).toBe(false);
    expect(isWebAppProvider('enabled-provider')).toBe(false);
    expect(isWebAppProvider('not-exists')).toBe(false);
    expect(isWebAppProvider()).toBe(false);
  });

  it('marks exactly chatgptweb, cursor and grok as webApp providers in the real catalog', () => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(...originalProviders);

    const webAppProviders = DEFAULT_MODEL_PROVIDER_LIST.filter((provider) =>
      isWebAppProvider(provider.id),
    )
      .map((provider) => provider.id)
      .sort();

    expect(webAppProviders).toEqual(['chatgptweb', 'cursor', 'grok']);
    expect(isWebAppProvider('openai')).toBe(false);
    expect(isWebAppProvider('anthropic')).toBe(false);
    expect(isWebAppProvider('supergrok')).toBe(false);
    expect(isWebAppProvider('chatgpt')).toBe(false);
  });

  it('marks exactly chatgpt, chatgptweb, cursor, grok and supergrok as rotating-refresh OAuth in the real catalog', () => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(...originalProviders);
    const personalOnly = DEFAULT_MODEL_PROVIDER_LIST.filter((provider) =>
      isRotatingRefreshOAuthProvider(provider.id),
    )
      .map((provider) => provider.id)
      .sort();
    expect(personalOnly).toEqual(['chatgpt', 'chatgptweb', 'cursor', 'grok', 'supergrok']);
    // GitHub Copilot uses a device flow but exchanges a platform-storable token.
    expect(isRotatingRefreshOAuthProvider('githubcopilot')).toBe(false);
  });

  it('declares the real paste-flow catalog entry (chatgptweb) and leaves the others alone', () => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(...originalProviders);

    expect(isProviderOAuthDeviceFlow('chatgptweb')).toBe(true);
    expect(getProviderOAuthGrantFlow('chatgptweb')).toBe('authorization_code_paste');
    expect(isProviderAccessTokenPasteAllowed('chatgptweb')).toBe(true);
    expect(getProviderPastedCredentialKind('chatgptweb')).toBe('accessToken');
    // The Codex-backed chatgpt provider keeps its device-code grant.
    expect(getProviderOAuthGrantFlow('chatgpt')).toBe('device_code');
    expect(isProviderAccessTokenPasteAllowed('chatgpt')).toBe(false);
    // Cursor is device-code shaped (URL + poll) and pastes a dashboard API key.
    expect(getProviderOAuthGrantFlow('cursor')).toBe('device_code');
    expect(isProviderAccessTokenPasteAllowed('cursor')).toBe(true);
    expect(getProviderPastedCredentialKind('cursor')).toBe('apiKey');
  });

  it('connects chatgptweb through the web session alone, and nothing else', () => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(...originalProviders);

    const sessionOnly = DEFAULT_MODEL_PROVIDER_LIST.filter((provider) =>
      isProviderWebSessionOnly(provider.id),
    ).map((provider) => provider.id);
    expect(sessionOnly).toEqual(['chatgptweb']);

    // The authorization-code grant stays declared: connections stored before the flag was
    // set renew through it, and dropping the config would kill them.
    const config = DEFAULT_MODEL_PROVIDER_LIST.find((provider) => provider.id === 'chatgptweb')
      ?.settings?.oauthDeviceFlow;
    expect(config?.authorizationCode?.authorizeEndpoint).toBeTruthy();
    expect(config?.clientId).toBeTruthy();
    expect(config?.refreshTokenGrant).toBe(true);
    expect(config?.tokenEndpoint).toBeTruthy();
    expect(config?.scopes?.length).toBeGreaterThan(0);
  });

  /**
   * TypeScript cannot narrow `webSessionOnly` on the card (the same interface is the wire
   * type for create/update, where the flag arrives as a plain optional boolean), so the
   * contradictory combinations are refused by `OAuthDeviceFlowConfigSchema` — and every
   * builtin card is held to that same contract here rather than only stored providers.
   */
  it('holds every builtin OAuth card to the stored-provider contract', () => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(...originalProviders);

    const rejected = DEFAULT_MODEL_PROVIDER_LIST.filter(
      (provider) => provider.settings?.oauthDeviceFlow,
    )
      .filter(
        (provider) =>
          !CreateAiProviderSchema.safeParse({
            id: provider.id,
            name: provider.name,
            settings: provider.settings,
            source: 'builtin',
          }).success,
      )
      .map((provider) => provider.id);

    expect(rejected).toEqual([]);
  });
});

// Captured before the suite above mutates the shared array in place.
const pickerIdsAtLoad = DEFAULT_MODEL_PROVIDER_LIST.map((provider) => provider.id);

describe('retired providers', () => {
  it('omits ai21 and github from the picker list', () => {
    expect(pickerIdsAtLoad).not.toContain('ai21');
    expect(pickerIdsAtLoad).not.toContain('github');
    // GitHub Copilot is a different product and stays listed.
    expect(pickerIdsAtLoad).toContain('githubcopilot');
  });
});
