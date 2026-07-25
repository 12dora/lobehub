import { describe, expect, it } from 'vitest';

import {
  buildAdminAiModelListKey,
  buildAdminAiProviderGetKey,
  buildAdminAiProviderListKey,
  buildAdminAiProviderRevisionsKey,
} from './swrKeys';

describe('admin AI catalog SWR keys', () => {
  it('includes every stable provider list contract filter', () => {
    expect(
      buildAdminAiProviderListKey({
        cursor: 'p-1',
        enabled: true,
        limit: 20,
        query: 'open',
        source: 'custom',
        status: 'published',
      }),
    ).toEqual(['admin.aiProviders.list', 'p-1', true, 20, 'open', 'custom', 'published']);
  });

  it('scopes provider caches by identity', () => {
    expect(buildAdminAiProviderGetKey('p-1')).toEqual(['admin.aiProviders.get', 'p-1']);
    expect(buildAdminAiProviderRevisionsKey('p-1', 7, 20)).toEqual([
      'admin.aiProviders.listRevisions',
      'p-1',
      7,
      20,
    ]);
  });

  it('includes every model list filter', () => {
    expect(
      buildAdminAiModelListKey({
        cursor: 'cursor',
        enabled: false,
        limit: 50,
        provider: 'openai',
        query: 'gpt',
        status: 'draft',
        type: 'chat',
      }),
    ).toEqual(['admin.aiModels.list', 'cursor', false, 50, 'openai', 'gpt', 'draft', 'chat']);
  });
});
