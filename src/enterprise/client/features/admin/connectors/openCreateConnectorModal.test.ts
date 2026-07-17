import { describe, expect, it } from 'vitest';

import {
  buildCreateConnectorInput,
  initialCreateConnectorState,
  reduceCreateConnectorState,
} from './openCreateConnectorModal';

describe('create Connector credential state', () => {
  it('clears an entered shared secret before switching to OAuth and vice versa', () => {
    const shared = {
      ...initialCreateConnectorState,
      credentialMode: 'shared_service_account' as const,
      secret: 'shared-token',
    };
    const oauth = reduceCreateConnectorState(shared, {
      type: 'mode',
      value: 'per_user_oauth',
    });
    expect(oauth.secret).toBe('');

    const backToShared = reduceCreateConnectorState(
      { ...oauth, secret: 'oauth-client-secret' },
      { type: 'mode', value: 'shared_service_account' },
    );
    expect(backToShared.secret).toBe('');
  });

  it('never emits the credential from the previous mode', () => {
    const oauth = reduceCreateConnectorState(
      {
        ...initialCreateConnectorState,
        credentialMode: 'shared_service_account',
        secret: 'shared-token',
      },
      { type: 'mode', value: 'per_user_oauth' },
    );
    const input = buildCreateConnectorInput({
      ...oauth,
      authorizationEndpoint: 'https://identity.example.com/authorize',
      clientId: 'calendar-client',
      displayName: 'Calendar',
      endpoint: 'https://calendar.example.com/mcp',
      issuer: 'https://identity.example.com',
      key: 'calendar',
      reason: 'create',
      scopes: 'calendar.read',
      tokenEndpoint: 'https://identity.example.com/token',
    });

    expect(input).not.toHaveProperty('sharedSecret');
    expect(input).not.toHaveProperty('oauthClientSecret');
    expect(JSON.stringify(input)).not.toContain('shared-token');
  });
});
