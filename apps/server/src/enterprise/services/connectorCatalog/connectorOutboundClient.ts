import type { SafeOutboundHttpClient, SafeOutboundResponse } from '../../security/outboundHttp';
import { SafeOutboundHttpError } from '../../security/outboundHttp';
import { PlatformConnectorContractError } from './errors';

const CONNECTOR_REQUEST_TIMEOUT_MS = 10_000;
const CONNECTOR_MAX_RESPONSE_BYTES = 1024 * 1024;
const CONNECTOR_MAX_REDIRECTS = 3;

export type ConnectorOutboundOperation =
  'discover' | 'oauth_refresh' | 'oauth_token' | 'oauth_userinfo' | 'runtime' | 'test';

export interface ConnectorOutboundJsonRequest {
  body?: unknown;
  bodyEncoding?: 'form' | 'json';
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  operation: ConnectorOutboundOperation;
  secretBearing?: boolean;
  url: string | URL;
}

export interface ConnectorOutboundJsonResponse {
  body: unknown;
  status: number;
  url: string;
}

const isJsonContentType = (value: string | null): boolean => {
  if (!value) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
};

/**
 * The only network boundary for M09 discovery, tests, and runtime calls.
 * It deliberately accepts SafeOutboundHttpClient rather than `fetch`.
 */
export class ConnectorOutboundClient {
  constructor(private readonly client: SafeOutboundHttpClient) {}

  assertAllowed = async (url: string | URL): Promise<void> => {
    try {
      await this.client.assertAllowed(url);
    } catch (error) {
      if (error instanceof SafeOutboundHttpError) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SSRF_BLOCKED');
      }
      throw error;
    }
  };

  requestJson = async (
    request: ConnectorOutboundJsonRequest,
  ): Promise<ConnectorOutboundJsonResponse> => {
    let body: string | undefined;
    try {
      body = encodeBody(request.body, request.bodyEncoding ?? 'json');
    } catch {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    if (body && Buffer.byteLength(body, 'utf8') > CONNECTOR_MAX_RESPONSE_BYTES) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    const oauthOperation = request.operation.startsWith('oauth_');
    const secretBearing =
      oauthOperation ||
      request.body !== undefined ||
      (request.headers !== undefined && Object.keys(request.headers).length > 0) ||
      request.secretBearing === true;

    let response: SafeOutboundResponse;
    try {
      response = await this.client.fetch(request.url, {
        body,
        headers: {
          Accept: 'application/json',
          ...(body
            ? {
                'Content-Type':
                  request.bodyEncoding === 'form'
                    ? 'application/x-www-form-urlencoded'
                    : 'application/json',
              }
            : {}),
          ...request.headers,
        },
        maxRedirects: CONNECTOR_MAX_REDIRECTS,
        maxResponseBytes: CONNECTOR_MAX_RESPONSE_BYTES,
        method: request.method ?? (body ? 'POST' : 'GET'),
        secretBearing,
        timeoutMs: CONNECTOR_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof SafeOutboundHttpError) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SSRF_BLOCKED');
      }
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }

    if (response.truncated || !isJsonContentType(response.headers.get('content-type'))) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    if (!response.ok) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }

    try {
      return { body: await response.json(), status: response.status, url: response.url };
    } catch {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
  };
}

const encodeBody = (body: unknown, encoding: 'form' | 'json'): string | undefined => {
  if (body === undefined) return undefined;
  if (encoding === 'json') return JSON.stringify(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string') {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    params.append(key, value);
  }
  return params.toString();
};
