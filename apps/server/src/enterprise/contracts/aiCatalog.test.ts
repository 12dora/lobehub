import { describe, expect, it } from 'vitest';

import {
  adminAiProviderCreateDraftInputSchema,
  aiModelDraftSchema,
  aiProviderDraftSchema,
  aiSecretMutationSchema,
  publishedAiCatalogSchema,
} from './aiCatalog';

describe('AI catalog contracts', () => {
  it('models explicit secret keep/replace/clear semantics', () => {
    expect(aiSecretMutationSchema.parse({ operation: 'keep' })).toEqual({ operation: 'keep' });
    expect(aiSecretMutationSchema.parse({ operation: 'clear' })).toEqual({ operation: 'clear' });
    expect(aiSecretMutationSchema.parse({ operation: 'replace', value: 'fake-value' })).toEqual({
      operation: 'replace',
      value: 'fake-value',
    });
    expect(() => aiSecretMutationSchema.parse({ operation: 'keep', value: 'smuggled' })).toThrow();
  });

  it('accepts only shared Model Bank types and retains non-executable metadata types', () => {
    const model = {
      abilities: {},
      config: null,
      contextWindowTokens: null,
      description: null,
      displayName: null,
      enabled: true,
      id: 'model-1',
      modelKey: 'model-1',
      parameters: {},
      pricing: null,
      providerId: 'provider-1',
      revision: 0,
      settings: {},
      sort: 0,
      status: 'draft',
    } as const;

    expect(aiModelDraftSchema.safeParse({ ...model, type: 'unknown-runtime-type' }).success).toBe(
      false,
    );
    expect(aiModelDraftSchema.parse({ ...model, type: 'text2music' }).type).toBe('text2music');
    expect(aiModelDraftSchema.parse({ ...model, type: 'realtime' }).type).toBe('realtime');
  });

  it('rejects ciphertext and secret references from admin and public outputs', () => {
    const admin = {
      checkModel: null,
      config: {},
      description: null,
      displayName: 'Alpha',
      enabled: true,
      fetchOnClient: false,
      id: 'provider-1',
      logo: null,
      models: [],
      providerKey: 'alpha',
      revision: 0,
      secret: { configured: true, fingerprint: 'fp', updatedAt: null },
      settings: {},
      sort: 0,
      source: 'custom',
      status: 'draft',
    };
    expect(
      aiProviderDraftSchema.safeParse({ ...admin, encryptedKeyVaults: 'cipher' }).success,
    ).toBe(false);
    expect(
      publishedAiCatalogSchema.safeParse({
        providers: [
          {
            description: null,
            displayName: 'Alpha',
            logo: null,
            models: [],
            providerKey: 'alpha',
            revision: 1,
            secretRef: 'forbidden',
            sort: 0,
            source: 'custom',
          },
        ],
        revision: 'revision',
      }).success,
    ).toBe(false);
  });

  it('rejects sensitive material in non-secret JSON while preserving numeric token metadata', () => {
    const base = {
      displayName: 'Alpha',
      providerKey: 'alpha',
      reason: 'create',
    };
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: { nested: { apiKey: 'plain-secret' } },
      }).success,
    ).toBe(false);
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        settings: { headers: { Authorization: 'plain-secret' } },
      }).success,
    ).toBe(false);
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: { endpoint: 'https://user:password@example.test/v1' },
      }).success,
    ).toBe(false);
    for (const key of [
      'x-api-key',
      'API_KEY',
      'client_secret',
      'refresh-token',
      'access%2Dtoken',
      'signature',
      'SIG',
      'X-Amz-Signature',
      'x_amz_signature',
      'X%2DAmz%2DSignature',
    ]) {
      expect(
        adminAiProviderCreateDraftInputSchema.safeParse({
          ...base,
          config: { endpoint: `https://example.test/v1?${key}=plain-secret` },
        }).success,
      ).toBe(false);
    }
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: { contextWindowTokens: 128_000, maxTokens: 4096 },
      }).success,
    ).toBe(true);
  });

  it('publishes only the deploymentName model config field', () => {
    const model = {
      abilities: {},
      config: { deploymentName: 'safe-deployment' },
      contextWindowTokens: null,
      description: null,
      displayName: null,
      modelKey: 'model-1',
      parameters: {},
      pricing: null,
      settings: {},
      sort: 0,
      type: 'chat',
    };
    const provider = {
      description: null,
      displayName: 'Alpha',
      logo: null,
      models: [model],
      providerKey: 'alpha',
      revision: 1,
      sort: 0,
      source: 'custom',
    };
    expect(
      publishedAiCatalogSchema.safeParse({ providers: [provider], revision: 'revision' }).success,
    ).toBe(true);
    expect(
      publishedAiCatalogSchema.safeParse({
        providers: [
          {
            ...provider,
            models: [{ ...model, config: { endpoint: 'https://secret.example.test' } }],
          },
        ],
        revision: 'revision',
      }).success,
    ).toBe(false);
  });
});
