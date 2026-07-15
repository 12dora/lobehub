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
 *
 * Enforces:
 * - maxResponseBytes during stream read (stops read + destroys connection)
 * - absolute wall-clock deadline (not only socket idle timeout)
 */
export const defaultPinnedTransport: PinnedTransport = (
  req: PinnedTransportRequest,
): Promise<PinnedTransportResponse> => {
  const { url, pinnedAddress, family, method, headers, body, timeoutMs, maxResponseBytes } = req;
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  const requestHeaders: Record<string, string> = {
    ...headers,
    Host: url.host,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let truncated = false;
    const chunks: Buffer[] = [];
    let total = 0;
    let responseMeta: {
      headers: Record<string, string | string[] | undefined>;
      status: number;
      statusText: string;
    } | null = null;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      fn();
    };

    const fail = (error: Error) => {
      settle(() => reject(error));
    };

    const succeed = () => {
      settle(() =>
        resolve({
          body: Buffer.concat(chunks, total),
          headers: responseMeta?.headers ?? {},
          status: responseMeta?.status ?? 0,
          statusText: responseMeta?.statusText ?? '',
          truncated,
        }),
      );
    };

    // Absolute wall-clock deadline: continuous streaming cannot reset this.
    const absoluteTimer = setTimeout(() => {
      const err = new Error(`Outbound request absolute deadline exceeded after ${timeoutMs}ms`);
      request.destroy(err);
      fail(err);
    }, timeoutMs);

    const request = lib.request(
      {
        family,
        headers: requestHeaders,
        hostname: pinnedAddress,
        method,
        path: `${url.pathname}${url.search}`,
        port,
        servername: isHttps ? url.hostname : undefined,
        // Socket idle timeout (resets on data) — absoluteTimer is the hard bound.
        timeout: timeoutMs,
      },
      (res) => {
        responseMeta = {
          headers: res.headers as Record<string, string | string[] | undefined>,
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
        };

        res.on('data', (chunk: Buffer | string) => {
          if (settled || truncated) return;

          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = maxResponseBytes - total;

          if (buf.length >= remaining) {
            if (remaining > 0) {
              chunks.push(buf.subarray(0, remaining));
              total = maxResponseBytes;
            }
            truncated = true;
            // Stop reading: destroy so the peer cannot keep flooding memory.
            // Soft-truncate: return bytes accumulated so far.
            res.destroy();
            request.destroy();
            succeed();
            return;
          }

          chunks.push(buf);
          total += buf.length;
        });

        res.on('end', () => {
          if (!settled) succeed();
        });

        res.on('error', (error: Error) => {
          // Expected after intentional destroy on truncation.
          if (settled || truncated) return;
          fail(error);
        });
      },
    );

    request.on('timeout', () => {
      const err = new Error(`Outbound request idle timed out after ${timeoutMs}ms`);
      request.destroy(err);
      fail(err);
    });

    request.on('error', (error: Error) => {
      if (settled) return;
      // destroy() after truncation may emit error; already succeeded or about to.
      if (truncated) {
        succeed();
        return;
      }
      fail(error);
    });

    if (body && body.length > 0) {
      request.write(body);
    }
    request.end();
  });
};
