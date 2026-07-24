import { describe, expect, it } from 'vitest';

import {
  adminAiProviderCreateDraftInputSchema,
  adminAiProviderGetBatchInputSchema,
  adminAiProviderGetInputSchema,
  aiModelDraftSchema,
  aiProviderDraftSchema,
  aiSecretMutationSchema,
  aiSecretStateSchema,
  BOUNDED_HEADER_MAP_MAX_ENTRIES,
  BOUNDED_HEADER_NAME_MAX,
  BOUNDED_HEADER_VALUE_MAX,
  BOUNDED_JSON_MAX_DEPTH,
  BOUNDED_JSON_MAX_KEYS_PER_OBJECT,
  BOUNDED_JSON_MAX_NODES,
  BOUNDED_JSON_MAX_SERIALIZED_BYTES,
  boundedHeaderMapSchema,
  publishedAiCatalogSchema,
} from './aiCatalog';

describe('AI catalog contracts', () => {
  it('get accepts exactly one of id or providerKey', () => {
    expect(adminAiProviderGetInputSchema.parse({ id: 'uuid-1' })).toEqual({ id: 'uuid-1' });
    expect(adminAiProviderGetInputSchema.parse({ providerKey: 'openai' })).toEqual({
      providerKey: 'openai',
    });
    expect(adminAiProviderGetInputSchema.safeParse({}).success).toBe(false);
    expect(
      adminAiProviderGetInputSchema.safeParse({ id: 'uuid-1', providerKey: 'openai' }).success,
    ).toBe(false);
  });

  it('getBatch accepts exactly one of ids or providerKeys (bounded)', () => {
    expect(adminAiProviderGetBatchInputSchema.parse({ ids: ['a', 'b'] })).toEqual({
      ids: ['a', 'b'],
    });
    expect(adminAiProviderGetBatchInputSchema.parse({ providerKeys: ['openai'] })).toEqual({
      providerKeys: ['openai'],
    });
    expect(adminAiProviderGetBatchInputSchema.safeParse({}).success).toBe(false);
    expect(
      adminAiProviderGetBatchInputSchema.safeParse({
        ids: ['a'],
        providerKeys: ['openai'],
      }).success,
    ).toBe(false);
  });

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

  it('rejects ciphertext, secret references, and credential fingerprints from admin and public outputs', () => {
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
      secret: { configured: true, updatedAt: null },
      settings: {},
      sort: 0,
      source: 'custom',
      status: 'draft',
    };
    expect(aiProviderDraftSchema.safeParse(admin).success).toBe(true);
    expect(
      aiProviderDraftSchema.safeParse({ ...admin, encryptedKeyVaults: 'cipher' }).success,
    ).toBe(false);
    // Fingerprint is server-internal — client-facing secret state must reject it.
    expect(
      aiSecretStateSchema.safeParse({
        configured: true,
        fingerprint: 'fp',
        updatedAt: null,
      }).success,
    ).toBe(false);
    expect(
      aiProviderDraftSchema.safeParse({
        ...admin,
        secret: { configured: true, fingerprint: 'fp', updatedAt: null },
      }).success,
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

  it('bounds recursive JSON depth/nodes/keys without throwing RangeError', () => {
    const base = {
      displayName: 'Alpha',
      providerKey: 'alpha',
      reason: 'create',
    };

    // Deep nesting just within / over the depth limit.
    let deepOk: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < BOUNDED_JSON_MAX_DEPTH; i += 1) {
      deepOk = { child: deepOk };
    }
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({ ...base, config: deepOk }).success,
    ).toBe(true);

    let deepBad: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < BOUNDED_JSON_MAX_DEPTH + 2; i += 1) {
      deepBad = { child: deepBad };
    }
    const deepResult = adminAiProviderCreateDraftInputSchema.safeParse({
      ...base,
      config: deepBad,
    });
    expect(deepResult.success).toBe(false);

    // Too many keys on a single object.
    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < BOUNDED_JSON_MAX_KEYS_PER_OBJECT + 1; i += 1) {
      manyKeys[`k${i}`] = i;
    }
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({ ...base, config: manyKeys }).success,
    ).toBe(false);

    // Too many total nodes (wide shallow tree).
    const wide: unknown[] = [];
    for (let i = 0; i < BOUNDED_JSON_MAX_NODES + 10; i += 1) {
      wide.push(i);
    }
    const wideResult = adminAiProviderCreateDraftInputSchema.safeParse({
      ...base,
      config: { items: wide },
    });
    expect(wideResult.success).toBe(false);

    // Serialized-size boundary: under limit accepts, over limit is a Zod failure.
    const underSize = 'x'.repeat(Math.max(1, BOUNDED_JSON_MAX_SERIALIZED_BYTES - 64));
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: { blob: underSize.slice(0, 100) },
      }).success,
    ).toBe(true);
    const overSizeBlob = 'y'.repeat(BOUNDED_JSON_MAX_SERIALIZED_BYTES);
    const sizeResult = adminAiProviderCreateDraftInputSchema.safeParse({
      ...base,
      config: { blob: overSizeBlob },
    });
    expect(sizeResult.success).toBe(false);
    if (!sizeResult.success) {
      expect(sizeResult.error.issues.some((issue) => /serialized size/i.test(issue.message))).toBe(
        true,
      );
    }

    // Genuinely stack-exhausting nesting: iterative walk returns a Zod failure, never throws.
    let stackDeep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 10_000; i += 1) {
      stackDeep = { child: stackDeep };
    }
    let stackResult: ReturnType<typeof adminAiProviderCreateDraftInputSchema.safeParse>;
    expect(() => {
      stackResult = adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: stackDeep,
      });
    }).not.toThrow();
    expect(stackResult!.success).toBe(false);
  });

  it('rejects non-JSON values that would reshape under JSONB persistence', () => {
    const base = {
      displayName: 'Alpha',
      providerKey: 'alpha',
      reason: 'create',
    };
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: { temperature: undefined },
      }).success,
    ).toBe(false);
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: { threshold: Number.NaN },
      }).success,
    ).toBe(false);
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: { threshold: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: { seenAt: new Date('2026-01-01T00:00:00.000Z') },
      }).success,
    ).toBe(false);
    // Still accepts pure JSON primitives / containers.
    expect(
      adminAiProviderCreateDraftInputSchema.safeParse({
        ...base,
        config: { flag: true, nested: { n: 1.5, s: 'ok' }, items: [null, false] },
      }).success,
    ).toBe(true);
  });

  it('bounds credential header maps by entry count, name/value length, and control chars', () => {
    expect(boundedHeaderMapSchema.safeParse({ Authorization: 'Bearer token-value' }).success).toBe(
      true,
    );
    expect(boundedHeaderMapSchema.safeParse({ 'X-Api\nKey': 'v' }).success).toBe(false);
    expect(boundedHeaderMapSchema.safeParse({ 'X-Key': 'a\u0000b' }).success).toBe(false);
    expect(
      boundedHeaderMapSchema.safeParse({ ['k'.repeat(BOUNDED_HEADER_NAME_MAX + 1)]: 'v' }).success,
    ).toBe(false);
    expect(
      boundedHeaderMapSchema.safeParse({ k: 'v'.repeat(BOUNDED_HEADER_VALUE_MAX + 1) }).success,
    ).toBe(false);
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < BOUNDED_HEADER_MAP_MAX_ENTRIES + 1; i += 1) {
      tooMany[`h${i}`] = 'v';
    }
    expect(boundedHeaderMapSchema.safeParse(tooMany).success).toBe(false);
    expect(
      aiSecretMutationSchema.safeParse({
        operation: 'replace',
        value: { customHeaders: tooMany },
      }).success,
    ).toBe(false);
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
