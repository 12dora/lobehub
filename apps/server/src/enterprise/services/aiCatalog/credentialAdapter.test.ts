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
      }),
    ).not.toThrow();
    expect(() =>
      normalizeAiCatalogExecutionCredentials({
        config: {},
        env: {},
        keyVaults: { apiKey: 'only-one-field' },
        providerKey: ModelProvider.Cloudflare,
        settings: {},
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
        env: {},
      }),
    ).toThrow('PLATFORM_CONFIG_VALIDATION_FAILED');
    expect(() => validateAiCatalogRuntimeProvider('custom', { sdkType: 'unknown-sdk' })).toThrow(
      'PLATFORM_CONFIG_VALIDATION_FAILED',
    );
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
      }),
    ).not.toThrow();
    expect(
      normalizeAiCatalogExecutionCredentials({
        config: { endpoint: 'https://published.example.test/v1' },
        env: { OPENAI_API_KEY: 'emergency-key', OPENAI_PROXY_URL: 'https://env.example.test' },
        keyVaults: { apiKey: 'published-key' },
        providerKey: ModelProvider.OpenAI,
        settings: {},
      }).keyVaults,
    ).toEqual({ apiKey: 'published-key', baseURL: 'https://published.example.test/v1' });
  });
});
