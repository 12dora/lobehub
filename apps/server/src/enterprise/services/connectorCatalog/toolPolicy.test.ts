import { describe, expect, it } from 'vitest';

import { assertConnectorScopesAllowed, resolveEffectiveConnectorToolPolicy } from './toolPolicy';

describe('connector tool policy', () => {
  it('gives platform deny absolute priority', () => {
    expect(
      resolveEffectiveConnectorToolPolicy({
        agentAllowed: true,
        platformPolicy: 'deny',
        userEnabled: true,
      }),
    ).toEqual({ allowed: false, deniedBy: 'platform' });
  });

  it('intersects platform allow with the agent allowlist', () => {
    expect(
      resolveEffectiveConnectorToolPolicy({
        agentAllowed: false,
        platformPolicy: 'allow',
        userEnabled: true,
      }),
    ).toEqual({ allowed: false, deniedBy: 'agent' });
  });

  it('lets a user disable but never re-enable an upstream denial', () => {
    expect(
      resolveEffectiveConnectorToolPolicy({
        agentAllowed: true,
        platformPolicy: 'allow',
        userEnabled: false,
      }),
    ).toEqual({ allowed: false, deniedBy: 'user' });
    expect(
      resolveEffectiveConnectorToolPolicy({
        agentAllowed: true,
        platformPolicy: 'allow',
        userEnabled: true,
      }),
    ).toEqual({ allowed: true, deniedBy: null });
  });

  it('rejects any scope outside the administrator-published allowlist', () => {
    expect(assertConnectorScopesAllowed(['issues:read', 'profile'], ['issues:read'])).toEqual([
      'issues:read',
    ]);
    expect(() =>
      assertConnectorScopesAllowed(['issues:read'], ['issues:read', 'issues:write']),
    ).toThrowError('PLATFORM_CONNECTOR_SCOPE_NOT_ALLOWED');
  });
});
