import { describe, expect, it } from 'vitest';

import { buildAdminConnectorGetKey, buildAdminConnectorListKey } from './swrKeys';

describe('admin Connector SWR keys', () => {
  it('returns null before read permission so forbidden pages issue no request', () => {
    expect(buildAdminConnectorListKey({ limit: 50 }, false)).toBeNull();
    expect(buildAdminConnectorGetKey('connector-1', false)).toBeNull();
  });

  it('includes every server-side list dimension in the cache key', () => {
    expect(
      buildAdminConnectorListKey(
        {
          credentialMode: 'per_user_oauth',
          cursor: 'calendar',
          enabled: true,
          limit: 20,
          query: 'cal',
          status: 'published',
        },
        true,
      ),
    ).toEqual(['adminConnector.list', 'calendar', 'per_user_oauth', true, 20, 'cal', 'published']);
  });
});
