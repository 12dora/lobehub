import { describe, expect, it } from 'vitest';

import {
  buildAdminAiModelDependentsKey,
  buildAdminAiProviderGetKey,
  buildAdminAiProviderListKey,
} from './swrKeys';

describe('admin AI catalog SWR keys', () => {
  it('includes every stable provider list contract filter', () => {
    expect(buildAdminAiProviderListKey({ cursor: 'p-1', limit: 20, status: 'published' })).toEqual([
      'admin.aiProviders.list',
      'p-1',
      20,
      'published',
    ]);
  });

  it('scopes provider and dependent caches by identity', () => {
    expect(buildAdminAiProviderGetKey('p-1')).toEqual(['admin.aiProviders.get', 'p-1']);
    expect(buildAdminAiModelDependentsKey('p-1', 'm-1')).toEqual([
      'admin.aiModels.dependents',
      'p-1',
      'm-1',
    ]);
  });
});
