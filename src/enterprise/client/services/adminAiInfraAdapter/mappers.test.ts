import { describe, expect, it } from 'vitest';

import { mapProviderDetail, mapProviderListItem, splitFormKeyVaults } from './mappers';

describe('adminAiInfraAdapter mappers', () => {
  it('maps list items with providerKey as id from draft enabled', () => {
    const item = mapProviderListItem({
      checkModel: null,
      connectionTest: null,
      config: {},
      description: 'desc',
      displayName: 'OpenAI',
      enabled: true,
      fetchOnClient: false,
      id: 'uuid-1',
      logo: null,
      providerKey: 'openai',
      revision: 1,
      secret: { configured: true, updatedAt: null },
      settings: {},
      sort: 0,
      source: 'builtin',
      status: 'published',
    });
    expect(item).toMatchObject({
      enabled: true,
      id: 'openai',
      name: 'OpenAI',
      source: 'builtin',
    });
  });

  it('maps detail with config.endpoint → keyVaults.baseURL and never secret plaintext', () => {
    const detail = mapProviderDetail({
      baseRevision: 2,
      draft: {
        checkModel: 'gpt-4o-mini',
        connectionTest: null,
        config: { endpoint: 'https://api.example.test/v1' },
        description: null,
        displayName: 'OpenAI',
        enabled: true,
        fetchOnClient: false,
        id: 'uuid-1',
        logo: null,
        models: [],
        providerKey: 'openai',
        revision: 2,
        secret: { configured: true, updatedAt: null },
        settings: { sdkType: 'openai' },
        sort: 0,
        source: 'builtin',
        status: 'published',
      },
      draftToken: 'a'.repeat(64),
      published: null,
    });
    expect(detail.id).toBe('openai');
    expect(detail.keyVaults).toEqual({ baseURL: 'https://api.example.test/v1' });
    expect(detail.secretConfigured).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/sk-|api[_-]?key\s*[:=]/i);
  });

  describe('splitFormKeyVaults (B1)', () => {
    it('maps baseURL to endpoint and leaves apiKey for secret merge', () => {
      expect(
        splitFormKeyVaults({
          apiKey: 'new-key',
          baseURL: 'https://example.test',
        }),
      ).toEqual({
        endpoint: 'https://example.test',
        secretParts: { apiKey: 'new-key' },
      });
    });

    it('only baseURL change yields empty secretParts (no vault wipe)', () => {
      expect(splitFormKeyVaults({ baseURL: 'https://only-endpoint.test' })).toEqual({
        endpoint: 'https://only-endpoint.test',
        secretParts: {},
      });
    });

    it('empty form vault yields no secret mutation payload fields', () => {
      expect(splitFormKeyVaults({ apiKey: '', baseURL: '' })).toEqual({
        endpoint: undefined,
        secretParts: {},
      });
    });
  });
});
