import type { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformConnectorContractError } from './errors';

const CONNECTOR_REQUEST_TIMEOUT_MS = 10_000;
const CONNECTOR_MAX_RESPONSE_BYTES = 1024 * 1024;
const CONNECTOR_MAX_REDIRECTS = 3;

export type ConnectorOutboundOperation = 'discover' | 'runtime' | 'test';

interface ConnectorOutboundJsonRequest {
  body?: unknown;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  operation: ConnectorOutboundOperation;
  url: string | URL;
}

interface ConnectorOutboundJsonResponse {
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

  assertAllowed = async (url: string | URL): Promise<void> => this.client.assertAllowed(url);

  requestJson = async (
    request: ConnectorOutboundJsonRequest,
  ): Promise<ConnectorOutboundJsonResponse> => {
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body && Buffer.byteLength(body, 'utf8') > CONNECTOR_MAX_RESPONSE_BYTES) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }

    const response = await this.client.fetch(request.url, {
      body,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...request.headers,
      },
      maxRedirects: CONNECTOR_MAX_REDIRECTS,
      maxResponseBytes: CONNECTOR_MAX_RESPONSE_BYTES,
      method: request.method ?? (body ? 'POST' : 'GET'),
      timeoutMs: CONNECTOR_REQUEST_TIMEOUT_MS,
    });

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
