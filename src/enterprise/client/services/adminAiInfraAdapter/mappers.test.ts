import { describe, expect, it } from 'vitest';

import {
  mapEnabledModel,
  mapModelListItem,
  mapProviderDetail,
  mapProviderListItem,
  splitFormKeyVaults,
} from './mappers';

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

  describe('legacy-alias picker visibility', () => {
    const legacyRow = {
      abilities: {},
      config: null,
      contextWindowTokens: null,
      description: null,
      displayName: 'GPT-5.6 Thinking',
      enabled: true,
      id: 'thinking-uuid',
      modelKey: 'gpt-5-6-thinking',
      parameters: {},
      pricing: null,
      providerId: 'provider-uuid',
      revision: 1,
      settings: { legacyAlias: 'gpt-5-6' },
      sort: 1,
      status: 'published' as const,
      type: 'chat' as const,
    };

    it('keeps legacy-alias rows visible on the admin model list (read-only in ModelItem)', () => {
      expect(mapModelListItem(legacyRow)).toMatchObject({
        enabled: true,
        id: 'gpt-5-6-thinking',
        settings: { legacyAlias: 'gpt-5-6' },
      });
      expect(mapModelListItem(legacyRow).visible).not.toBe(false);
    });

    it('hides legacy-alias rows on the admin service-model selector', () => {
      expect(mapEnabledModel(legacyRow, 'chatgptweb')).toMatchObject({
        enabled: true,
        id: 'gpt-5-6-thinking',
        providerId: 'chatgptweb',
        visible: false,
      });
    });

    it('rewrites published gpt5_6ReasoningEffort and hides stale auto/pro leftovers', () => {
      const family = mapEnabledModel(
        {
          ...legacyRow,
          modelKey: 'gpt-5-6',
          settings: { extendParams: ['gpt5_6ReasoningEffort'], searchImpl: 'params' },
        },
        'chatgptweb',
      );
      expect(family.settings).toEqual({
        extendParams: ['chatgptWebReasoningEffort'],
        searchImpl: 'params',
      });
      expect(family.visible).not.toBe(false);

      const auto = mapEnabledModel(
        {
          ...legacyRow,
          modelKey: 'auto',
          settings: { extendParams: ['gpt5_6ReasoningEffort'] },
        },
        'chatgptweb',
      );
      expect(auto).toMatchObject({
        enabled: true,
        settings: { legacyAlias: 'gpt-5-6' },
        visible: false,
      });

      const pro = mapEnabledModel(
        {
          ...legacyRow,
          modelKey: 'gpt-5-6-pro',
          settings: { extendParams: ['chatgptWebReasoningEffort'] },
        },
        'chatgptweb',
      );
      expect(pro).toMatchObject({
        enabled: true,
        settings: { legacyAlias: 'gpt-5-6' },
        visible: false,
      });
    });
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

    it('empty form vault yields clear endpoint (null) and no secret mutation', () => {
      expect(splitFormKeyVaults({ apiKey: '', baseURL: '' })).toEqual({
        endpoint: null,
        secretParts: {},
      });
    });

    it('absent keyVaults leaves endpoint undefined (no clear)', () => {
      expect(splitFormKeyVaults(undefined)).toEqual({
        endpoint: undefined,
        secretParts: {},
      });
      expect(splitFormKeyVaults({ apiKey: 'only' })).toEqual({
        endpoint: undefined,
        secretParts: { apiKey: 'only' },
      });
    });
  });
});
