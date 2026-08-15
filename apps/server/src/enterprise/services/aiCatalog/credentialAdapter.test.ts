import { ModelProvider } from 'model-bank';
import { describe, expect, it } from 'vitest';

import {
  credentialStringLeaves,
  normalizeAiCatalogExecutionCredentials,
  providerCredentialKeys,
  validateAiCatalogCredentialShape,
  validateAiCatalogRuntimeProvider,
} from './credentialAdapter';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';

describe('AI catalog credential adapter', () => {
  it('does not treat structural authType/region fields as credential leaves', () => {
    const leaves = credentialStringLeaves({
      apiKey: 'sk-live-super-secret-key-value',
      authType: 'bearer',
      region: 'us-east-1',
    });
    expect(leaves).toEqual(['sk-live-super-secret-key-value']);
    expect(leaves).not.toContain('bearer');
    expect(leaves).not.toContain('us-east-1');

    // Structural vault fields may also appear as public catalog metadata without leaking secrets.
    expect(() =>
      assertAiCatalogPublicFieldsExcludeCredentials(
        {
          description: 'Primary region catalog entry',
          settings: { region: 'us-east-1', sdkType: 'openai' },
        },
        {
          apiKey: 'sk-live-super-secret-key-value',
          authType: 'bearer',
          region: 'us-east-1',
        },
      ),
    ).not.toThrow();

    // Direct secret leakage into public fields still fails closed.
    expect(() =>
      assertAiCatalogPublicFieldsExcludeCredentials(
        { description: 'key is sk-live-super-secret-key-value' },
        { apiKey: 'sk-live-super-secret-key-value' },
      ),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
  });

  it('keeps short secrets from known keys and detects exact/token leakage', () => {
    expect(credentialStringLeaves({ apiKey: 'ab12', authType: 'none' })).toEqual(['ab12']);
    expect(credentialStringLeaves({ password: 'p@ss' })).toEqual(['p@ss']);

    // Exact / token-aware short-secret disclosure fails closed.
    expect(() =>
      assertAiCatalogPublicFieldsExcludeCredentials(
        { description: 'api key ab12 for staging' },
        { apiKey: 'ab12' },
      ),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(() =>
      assertAiCatalogPublicFieldsExcludeCredentials({ description: 'ab12' }, { apiKey: 'ab12' }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');

    // Substring collision of a short secret inside a longer public token is ignored.
    expect(() =>
      assertAiCatalogPublicFieldsExcludeCredentials(
        { description: 'label-ab12-extra' },
        { apiKey: 'ab12' },
      ),
    ).not.toThrow();
  });

  it('does not treat non-secret custom header values as credential leaves unless long', () => {
    expect(
      credentialStringLeaves({
        apiKey: 'sk-live-super-secret-key-value',
        customHeaders: {
          'Authorization': 'tok',
          'X-Trace-Id': 'trace-correlation-identifier-value',
          'X-Public-Label': 'short',
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        'sk-live-super-secret-key-value',
        'tok',
        'trace-correlation-identifier-value',
      ]),
    );
    expect(
      credentialStringLeaves({
        customHeaders: { 'X-Public-Label': 'short' },
      }),
    ).toEqual([]);
  });

  it('validates structured provider credentials', () => {
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: {},
        keyVaults: {
          accessKeyId: 'access',
          region: 'us-east-1',
          secretAccessKey: 'secret',
        },
        providerKey: ModelProvider.Bedrock,
        settings: {},
        source: 'builtin',
      }),
    ).not.toThrow();
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: {},
        keyVaults: { apiKey: 'only-one-field' },
        providerKey: ModelProvider.Cloudflare,
        settings: {},
        source: 'builtin',
      }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
  });

  it('uses the published endpoint over a legacy secret baseURL', () => {
    expect(
      normalizeAiCatalogExecutionCredentials({
        config: { endpoint: 'https://published.example.test/v1' },
        env: {},
        keyVaults: { apiKey: 'key', baseURL: 'https://legacy.example.test/v1' },
        providerKey: 'custom-openai',
        settings: { sdkType: ModelProvider.OpenAI },
        source: 'custom',
      }).keyVaults.baseURL,
    ).toBe('https://published.example.test/v1');
  });

  it('requires explicit endpoints for credential-free runtimes and rejects unknown SDKs', () => {
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        keyVaults: {},
        providerKey: ModelProvider.Ollama,
        settings: {},
        source: 'builtin',
        env: {},
      }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(() =>
      validateAiCatalogRuntimeProvider('custom', { sdkType: 'unknown-sdk' }, 'custom'),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(() =>
      validateAiCatalogCredentialShape(ModelProvider.Bedrock, { apiKey: 'key', username: 'bad' }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
  });

  it('allows explicit environment emergency credentials while published values win', () => {
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: { OPENAI_API_KEY: 'emergency-key' },
        keyVaults: {},
        providerKey: ModelProvider.OpenAI,
        settings: {},
        source: 'builtin',
      }),
    ).not.toThrow();
    expect(
      normalizeAiCatalogExecutionCredentials({
        config: { endpoint: 'https://published.example.test/v1' },
        env: { OPENAI_API_KEY: 'emergency-key', OPENAI_PROXY_URL: 'https://env.example.test' },
        keyVaults: { apiKey: 'published-key' },
        providerKey: ModelProvider.OpenAI,
        settings: {},
        source: 'builtin',
      }).keyVaults,
    ).toEqual({ apiKey: 'published-key', baseURL: 'https://published.example.test/v1' });
  });

  it('uses one canonical runtime provider rule for builtin and custom providers', () => {
    expect(
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: { AZURE_API_KEY: 'env-key', AZURE_ENDPOINT: 'https://azure.example.test' },
        keyVaults: {},
        providerKey: ModelProvider.Azure,
        settings: { sdkType: ModelProvider.OpenAI },
        source: 'builtin',
      }).runtimeProvider,
    ).toBe(ModelProvider.Azure);
    expect(
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: { OPENAI_API_KEY: 'env-key' },
        keyVaults: {},
        providerKey: ModelProvider.Azure,
        settings: {},
        source: 'custom',
      }).runtimeProvider,
    ).toBe(ModelProvider.OpenAI);
    expect(
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: { AZURE_API_KEY: 'env-key', AZURE_ENDPOINT: 'https://azure.example.test' },
        keyVaults: {},
        providerKey: 'custom-azure',
        settings: { sdkType: ModelProvider.Azure },
        source: 'custom',
      }).runtimeProvider,
    ).toBe(ModelProvider.Azure);
  });

  it.each([
    [
      ModelProvider.AzureAI,
      { AZUREAI_ENDPOINT: 'https://azure-ai.example.test', AZUREAI_ENDPOINT_KEY: 'key' },
    ],
    [ModelProvider.GiteeAI, { GITEE_AI_API_KEY: 'key' }],
    [ModelProvider.Github, { GITHUB_TOKEN: 'key' }],
    [ModelProvider.OllamaCloud, { OLLAMA_CLOUD_API_KEY: 'key' }],
    [ModelProvider.TencentCloud, { TENCENT_CLOUD_API_KEY: 'key' }],
  ])('accepts the real %s ModelRuntime environment fallback', (providerKey, env) => {
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env,
        keyVaults: {},
        providerKey,
        settings: {},
        source: 'builtin',
      }),
    ).not.toThrow();
  });

  it.each([ModelProvider.GithubCopilot, ModelProvider.LobeHub])(
    'does not invent a %s API-key environment fallback',
    (providerKey) => {
      const envPrefix = providerKey.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_');
      expect(() =>
        normalizeAiCatalogExecutionCredentials({
          config: {},
          env: { [`${envPrefix}_API_KEY`]: 'false-ready-key' },
          keyVaults: {},
          providerKey,
          settings: {},
          source: 'builtin',
        }),
      ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    },
  );

  it('accepts SuperGrok as a shared-OAuth platform runtime with an OAuth-only vault', () => {
    expect(() =>
      validateAiCatalogRuntimeProvider(ModelProvider.SuperGrok, {}, 'builtin'),
    ).not.toThrow();
    // API-key style credentials remain invalid — only the OAuth vault shape is accepted.
    expect(() =>
      validateAiCatalogCredentialShape(ModelProvider.SuperGrok, { apiKey: 'sk-any' }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(() =>
      validateAiCatalogCredentialShape(ModelProvider.SuperGrok, {
        oauthAccessToken: 'at-1',
        oauthRefreshToken: 'rt-1',
        oauthTokenExpiresAt: '1750000000000',
      }),
    ).not.toThrow();
    // Execution needs the full rotating pair; env vars never substitute for it.
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: { SUPERGROK_API_KEY: 'false-ready-key' },
        keyVaults: { oauthAccessToken: 'at-1' },
        providerKey: ModelProvider.SuperGrok,
        settings: {},
        source: 'builtin',
      }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: {},
        keyVaults: { oauthAccessToken: 'at-1', oauthRefreshToken: 'rt-1' },
        providerKey: ModelProvider.SuperGrok,
        settings: {},
        source: 'builtin',
      }),
    ).not.toThrow();
  });

  it('accepts ChatGPT as a shared-OAuth platform runtime requiring the Codex account id', () => {
    expect(() =>
      validateAiCatalogRuntimeProvider(ModelProvider.ChatGPT, {}, 'builtin'),
    ).not.toThrow();
    expect(() =>
      validateAiCatalogCredentialShape(ModelProvider.ChatGPT, { apiKey: 'sk-any' }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(() =>
      validateAiCatalogCredentialShape(ModelProvider.ChatGPT, {
        oauthAccessToken: 'at-1',
        oauthAccountId: 'acct-1',
        oauthRefreshToken: 'rt-1',
        oauthTokenExpiresAt: '1750000000000',
      }),
    ).not.toThrow();
    // Missing account id is incomplete — the Codex backend requires it per request.
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: {},
        keyVaults: { oauthAccessToken: 'at-1', oauthRefreshToken: 'rt-1' },
        providerKey: ModelProvider.ChatGPT,
        settings: {},
        source: 'builtin',
      }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: {},
        keyVaults: {
          oauthAccessToken: 'at-1',
          oauthAccountId: 'acct-1',
          oauthRefreshToken: 'rt-1',
        },
        providerKey: ModelProvider.ChatGPT,
        settings: {},
        source: 'builtin',
      }),
    ).not.toThrow();
  });

  it('accepts ChatGPT Web with only an access token, plus its device-id and email leaves', () => {
    expect(() =>
      validateAiCatalogCredentialShape(ModelProvider.ChatGPTWeb, {
        oauthAccessToken: 'at-1',
        oauthAccountEmail: 'user@example.com',
        oauthAccountId: 'acct-1',
        oauthDeviceId: 'device-1',
        oauthRefreshToken: 'rt-1',
        oauthTokenExpiresAt: '1750000000000',
      }),
    ).not.toThrow();
    // Unknown leaves stay hard-rejected.
    expect(() =>
      validateAiCatalogCredentialShape(ModelProvider.ChatGPTWeb, { apiKey: 'sk-any' }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');

    // The access-token paste fallback has neither a refresh token nor an account id, and
    // it still chats — rejecting it as incomplete would break the documented fallback.
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: {},
        keyVaults: { oauthAccessToken: 'at-1', oauthDeviceId: 'device-1' },
        providerKey: ModelProvider.ChatGPTWeb,
        settings: {},
        source: 'builtin',
      }),
    ).not.toThrow();
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: {},
        keyVaults: { oauthRefreshToken: 'rt-1' },
        providerKey: ModelProvider.ChatGPTWeb,
        settings: {},
        source: 'builtin',
      }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
  });

  it('exposes the credential shape as a capability set', () => {
    expect(providerCredentialKeys(ModelProvider.ChatGPTWeb).has('oauthDeviceId')).toBe(true);
    expect(providerCredentialKeys(ModelProvider.ChatGPT).has('oauthDeviceId')).toBe(false);
    expect(providerCredentialKeys(ModelProvider.SuperGrok).has('oauthAccountEmail')).toBe(false);
    // Unknown providers fall back to the OpenAI-compatible shape.
    expect([...providerCredentialKeys('some-custom-provider')]).toEqual(['apiKey', 'baseURL']);
  });
});
