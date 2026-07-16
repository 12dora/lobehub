import { describe, expect, it, vi } from 'vitest';

import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { ConnectorOutboundClient } from './connectorOutboundClient';
import { ConnectorOAuthOutboundAdapter } from './oauthOutboundAdapter';

describe('ConnectorOAuthOutboundAdapter', () => {
  it('routes discovery, token, refresh, and userinfo through one safe outbound adapter', async () => {
    const outbound = new ConnectorOutboundClient(new SafeOutboundHttpClient());
    const requestJson = vi.spyOn(outbound, 'requestJson').mockResolvedValue({
      body: {},
      status: 200,
      url: 'https://identity.example.test',
    });
    const oauth = new ConnectorOAuthOutboundAdapter(outbound);

    await oauth.discover('https://identity.example.test/.well-known/oauth-authorization-server');
    await oauth.exchangeCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'code',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'https://aihub.example.test/oauth/connector/callback',
      tokenEndpoint: 'https://identity.example.test/token',
    });
    await oauth.refresh({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      tokenEndpoint: 'https://identity.example.test/token',
    });
    await oauth.userInfo('https://identity.example.test/userinfo', 'access-token');

    expect(requestJson.mock.calls.map(([request]) => request.operation)).toEqual([
      'discover',
      'oauth_token',
      'oauth_refresh',
      'oauth_userinfo',
    ]);
    for (const [request] of requestJson.mock.calls.slice(1)) {
      expect(request.secretBearing).toBe(true);
    }
  });
});
