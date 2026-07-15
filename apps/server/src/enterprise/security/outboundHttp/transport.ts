import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

import type {
  DnsResolver,
  PinnedTransport,
  PinnedTransportRequest,
  PinnedTransportResponse,
  ResolvedAddress,
} from './types';

export const defaultDnsResolve: DnsResolver = async (
  hostname: string,
): Promise<ResolvedAddress[]> => {
  // hostname may be an IP already
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({
    address: r.address,
    family: (r.family === 6 ? 6 : 4) as 4 | 6,
  }));
};

/**
 * Node http/https transport that connects to the pinned IP while sending
 * Host / SNI for the original URL hostname (DNS rebinding defense).
 */
export const defaultPinnedTransport: PinnedTransport = (
  req: PinnedTransportRequest,
): Promise<PinnedTransportResponse> => {
  const { url, pinnedAddress, family, method, headers, body, timeoutMs } = req;
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  const requestHeaders: Record<string, string> = {
    ...headers,
    Host: url.host,
  };

  return new Promise((resolve, reject) => {
    const request = lib.request(
      {
        family,
        headers: requestHeaders,
        hostname: pinnedAddress,
        method,
        path: `${url.pathname}${url.search}`,
        port,
        servername: isHttps ? url.hostname : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks),
            headers: res.headers as Record<string, string | string[] | undefined>,
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
          });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error(`Outbound request timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);

    if (body && body.length > 0) {
      request.write(body);
    }
    request.end();
  });
};
