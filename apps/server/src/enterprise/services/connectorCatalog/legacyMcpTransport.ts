import { MCPService } from '../../../services/mcp';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';

const safeOutbound = new SafeOutboundHttpClient();

const safeMcpFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const headers = Object.fromEntries(new Headers(init?.headers ?? request?.headers).entries());
  return safeOutbound.streamFetch(request?.url ?? input.toString(), {
    body: init?.body as string | Uint8Array | undefined,
    headers,
    method: init?.method ?? request?.method,
    secretBearing: Object.keys(headers).length > 0 || init?.body !== undefined,
    signal: init?.signal,
  });
};

/** Web-owned MCP client. Every HTTP hop traverses the M13 SafeOutbound boundary. */
export const platformSafeMcpService = new MCPService({ httpFetch: safeMcpFetch });
