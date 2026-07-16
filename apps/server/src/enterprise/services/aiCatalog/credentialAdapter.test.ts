import { ModelProvider } from 'model-bank';
import { describe, expect, it } from 'vitest';

import {
  normalizeAiCatalogExecutionCredentials,
  validateAiCatalogCredentialShape,
  validateAiCatalogRuntimeProvider,
} from './credentialAdapter';

describe('AI catalog credential adapter', () => {
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
});
