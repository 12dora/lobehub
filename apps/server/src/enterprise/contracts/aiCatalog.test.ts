import { describe, expect, it } from 'vitest';

import {
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
