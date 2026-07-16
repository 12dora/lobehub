import { describe, expect, it } from 'vitest';

import {
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
});
