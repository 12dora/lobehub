import type {
  ConnectorOutboundClient,
  ConnectorOutboundJsonResponse,
} from './connectorOutboundClient';

interface OAuthTokenRequest {
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint: string;
}

interface OAuthRefreshRequest {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  tokenEndpoint: string;
}

/** OAuth discovery/token/refresh/userinfo share the same SSRF-safe adapter. */
export class ConnectorOAuthOutboundAdapter {
  constructor(private readonly outbound: ConnectorOutboundClient) {}

  discover = async (discoveryUrl: string): Promise<ConnectorOutboundJsonResponse> =>
    this.outbound.requestJson({ operation: 'discover', url: discoveryUrl });

  preflightAuthorization = async (authorizationEndpoint: string): Promise<void> => {
    await this.outbound.preflight(authorizationEndpoint);
  };

  preflightToken = async (tokenEndpoint: string): Promise<void> => {
    await this.outbound.preflight(tokenEndpoint);
  };

  exchangeCode = async (request: OAuthTokenRequest): Promise<ConnectorOutboundJsonResponse> =>
    this.outbound.requestJson({
      body: {
        client_id: request.clientId,
        ...(request.clientSecret ? { client_secret: request.clientSecret } : {}),
        code: request.code,
        code_verifier: request.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: request.redirectUri,
      },
      bodyEncoding: 'form',
      method: 'POST',
      operation: 'oauth_token',
      secretBearing: true,
      url: request.tokenEndpoint,
    });

  refresh = async (request: OAuthRefreshRequest): Promise<ConnectorOutboundJsonResponse> =>
    this.outbound.requestJson({
      body: {
        client_id: request.clientId,
        ...(request.clientSecret ? { client_secret: request.clientSecret } : {}),
        grant_type: 'refresh_token',
        refresh_token: request.refreshToken,
      },
      bodyEncoding: 'form',
      method: 'POST',
      operation: 'oauth_refresh',
      secretBearing: true,
      url: request.tokenEndpoint,
    });

  userInfo = async (
    userInfoEndpoint: string,
    accessToken: string,
  ): Promise<ConnectorOutboundJsonResponse> =>
    this.outbound.requestJson({
      headers: { Authorization: `Bearer ${accessToken}` },
      operation: 'oauth_userinfo',
      secretBearing: true,
      url: userInfoEndpoint,
    });
}
