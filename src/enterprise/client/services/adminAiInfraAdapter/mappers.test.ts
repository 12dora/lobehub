import { describe, expect, it } from 'vitest';

import { mapProviderDetail, mapProviderListItem } from './mappers';

describe('adminAiInfraAdapter mappers', () => {
  it('maps list items with providerKey as id and never archives', () => {
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
      secret: { configured: true, fingerprint: 'fp', updatedAt: null },
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

  it('maps detail without secret plaintext and flags secretConfigured', () => {
    const detail = mapProviderDetail({
      baseRevision: 2,
      draft: {
        checkModel: 'gpt-4o-mini',
        connectionTest: null,
        config: {},
        description: null,
        displayName: 'OpenAI',
        enabled: true,
        fetchOnClient: false,
        id: 'uuid-1',
        logo: null,
        models: [],
        providerKey: 'openai',
        revision: 2,
        secret: { configured: true, fingerprint: 'fp', updatedAt: null },
        settings: { sdkType: 'openai' },
        sort: 0,
        source: 'builtin',
        status: 'published',
      },
      draftToken: 'a'.repeat(64),
      published: null,
    });
    expect(detail.id).toBe('openai');
    expect(detail.keyVaults).toEqual({});
    expect(detail.secretConfigured).toBe(true);
    expect(detail.fetchOnClient).toBe(false);
    expect(JSON.stringify(detail)).not.toMatch(/sk-|api[_-]?key\s*[:=]/i);
  });
});
