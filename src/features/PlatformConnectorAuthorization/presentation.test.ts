import { describe, expect, it } from 'vitest';

import { canDisconnectConnector, resolveConnectorAvailability } from './presentation';
import type { ManagedConnector } from './types';

const connector = (overrides: Partial<ManagedConnector> = {}): ManagedConnector => ({
  binding: null,
  credentialMode: 'none',
  description: null,
  displayName: 'Calendar',
  id: 'connector-1',
  key: 'calendar',
  publishedRevision: 1,
  tools: [],
  ...overrides,
});

describe('platform Connector presentation', () => {
  it.each(['none', 'shared_service_account'] as const)(
    'marks %s as available without exposing credential details',
    (credentialMode) => {
      expect(resolveConnectorAvailability(connector({ credentialMode }))).toBe('available');
    },
  );

  it('requires a connected per-user binding', () => {
    const item = connector({ credentialMode: 'per_user_oauth' });
    expect(resolveConnectorAvailability(item)).toBe('authorization_required');
    expect(
      resolveConnectorAvailability({
        ...item,
        binding: {
          connectedAt: new Date(),
          expiresAt: null,
          id: 'binding-1',
          lastErrorCategory: null,
          scopes: [],
          status: 'connected',
          updatedAt: new Date(),
        },
      }),
    ).toBe('available');
  });

  it('only offers disconnect for binding lifecycle states that can exist', () => {
    expect(canDisconnectConnector(null)).toBe(false);
    expect(
      canDisconnectConnector({
        connectedAt: null,
        expiresAt: null,
        id: 'binding-1',
        lastErrorCategory: null,
        scopes: [],
        status: 'revoked',
        updatedAt: new Date(),
      }),
    ).toBe(false);
  });
});
