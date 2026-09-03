import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';

import { expandIpv6, isIpv4InCidr, isPubliclyRoutableIp, normalizeIp } from './policy';
import type {
  DnsResolver,
  PinnedTransport,
  PinnedTransportRequest,
  PinnedTransportResponse,
  ResolvedAddress,
} from './types';

const NO_BODY_RESPONSE_STATUSES = new Set([204, 205, 304]);

export type PinnedTransportRoute = 'direct' | 'proxy';

/** Lazy per-protocol agents so NODE_USE_ENV_PROXY cannot hijack the default global agent. */
let directHttpAgent: http.Agent | undefined;
let directHttpsAgent: https.Agent | undefined;
let proxyHttpAgent: http.Agent | undefined;
let proxyHttpsAgent: https.Agent | undefined;

const directAgent = (isHttps: boolean): http.Agent => {
  if (isHttps) {
    directHttpsAgent ??= new https.Agent({ keepAlive: true });
    return directHttpsAgent;
  }
  directHttpAgent ??= new http.Agent({ keepAlive: true });
  return directHttpAgent;
};

const envProxyAgent = (isHttps: boolean): http.Agent => {
  // Node 24 `proxyEnv` enables built-in CONNECT/tunnelling from HTTP(S)_PROXY.
  if (isHttps) {
    proxyHttpsAgent ??= new https.Agent({ keepAlive: true, proxyEnv: process.env });
    return proxyHttpsAgent;
  }
  proxyHttpAgent ??= new http.Agent({ keepAlive: true, proxyEnv: process.env });
  return proxyHttpAgent;
};

const proxyUrlForScheme = (env: NodeJS.Dict<string>, protocol: string): string | undefined => {
  const value =
    protocol === 'https:'
      ? (env.HTTPS_PROXY ?? env.https_proxy)
      : protocol === 'http:'
        ? (env.HTTP_PROXY ?? env.http_proxy)
        : undefined;
  return value?.trim() || undefined;
};

const ipv6ToBigInt = (ip: string): bigint | null => {
  const expanded = expandIpv6(ip);
  if (isIP(expanded) !== 6) return null;
  return expanded
    .split(':')
    .reduce((acc, hextet) => (acc << 16n) + BigInt(Number.parseInt(hextet, 16)), 0n);
};

const isPinnedIpInCidr = (ip: string, cidr: string): boolean => {
  const separator = cidr.lastIndexOf('/');
  if (separator <= 0) return false;
  const networkRaw = cidr.slice(0, separator).replaceAll(/^\[|\]$/g, '');
  const prefix = Number(cidr.slice(separator + 1));
  if (!Number.isInteger(prefix)) return false;
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const networkVersion = isIP(networkRaw);
  if (networkVersion === 4) {
    if (prefix < 0 || prefix > 32 || isIP(normalized) !== 4) return false;
    if (prefix === 0) return true;
    return isIpv4InCidr(normalized, networkRaw, prefix);
  }
  if (networkVersion === 6) {
    if (prefix < 0 || prefix > 128) return false;
    const address = ipv6ToBigInt(normalized);
    const network = ipv6ToBigInt(networkRaw);
    if (address === null || network === null) return false;
    if (prefix === 0) return true;
    const shift = 128n - BigInt(prefix);
    return address >> shift === network >> shift;
  }
  return false;
};

const hostMatchesNoProxyPattern = (hostname: string, pattern: string): boolean => {
  if (pattern === '*') return true;
  if (pattern === hostname) return true;
  if (pattern.startsWith('.')) {
    const suffix = pattern.slice(1);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname.endsWith(`.${pattern}`);
};

const isNoProxyExempt = (
  env: NodeJS.Dict<string>,
  hostname: string,
  pinnedAddress: string,
): boolean => {
  const raw = env.NO_PROXY ?? env.no_proxy ?? '';
  const host = hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
  const pinnedNormalized = normalizeIp(pinnedAddress);

  for (const entry of raw.split(/[,\s]+/)) {
    const pattern = entry
      .trim()
      .toLowerCase()
      .replaceAll(/^\[|\]$/g, '');
    if (!pattern) continue;
    if (pattern === '*') return true;
    if (pattern.includes('/')) {
      if (isPinnedIpInCidr(pinnedAddress, pattern)) return true;
      continue;
    }
    if (isIP(pattern)) {
      const entryIp = normalizeIp(pattern);
      if (entryIp && (entryIp === pinnedNormalized || entryIp === normalizeIp(host))) return true;
      continue;
    }
    if (hostMatchesNoProxyPattern(host, pattern)) return true;
  }
  return false;
};

/**
 * Decide whether a DNS-pinned hop must bypass the env proxy (direct TCP to the
 * pinned IP) or use Node's built-in HTTP(S)_PROXY agent.
 */
export const resolvePinnedTransportRoute = ({
  env,
  pinnedAddress,
  url,
}: {
  env: NodeJS.Dict<string>;
  pinnedAddress: string;
  url: URL;
}): PinnedTransportRoute => {
  if (env.NODE_USE_ENV_PROXY !== '1') return 'direct';
  if (!proxyUrlForScheme(env, url.protocol)) return 'direct';
  if (!isPubliclyRoutableIp(pinnedAddress)) return 'direct';
  if (isNoProxyExempt(env, url.hostname, pinnedAddress)) return 'direct';
  return 'proxy';
};

const buildPinnedRequestOptions = (
  req: PinnedTransportRequest,
): { lib: typeof http | typeof https; options: https.RequestOptions } => {
  const { url, pinnedAddress, family, method, headers, timeoutMs } = req;
  const isHttps = url.protocol === 'https:';
  const route = resolvePinnedTransportRoute({ env: process.env, pinnedAddress, url });
  const viaProxy = route === 'proxy';
  // Both routes pin TCP to the pre-resolved IP (hostname + family). The proxy
  // agent only changes how the hop is reached: Node issues CONNECT
  // <pinnedIP>:<port> (https) or an absolute-URI request to the IP (http),
  // while Host and TLS servername stay the original hostname.
  return {
    lib: isHttps ? https : http,
    options: {
      agent: viaProxy ? envProxyAgent(isHttps) : directAgent(isHttps),
      family,
      headers: {
        ...headers,
        Host: url.host,
      },
      hostname: pinnedAddress,
      method,
      path: `${url.pathname}${url.search}`,
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      servername: isHttps ? url.hostname : undefined,
      timeout: timeoutMs,
    },
  };
};

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
  const { body, timeoutMs, maxResponseBytes, signal } = req;
  const { lib, options } = buildPinnedRequestOptions(req);

  return new Promise((resolve, reject) => {
    let settled = false;
    let truncated = false;
    let response: http.IncomingMessage | undefined;
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
      signal?.removeEventListener('abort', onAbort);
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

    const onAbort = () => {
      const error = new DOMException('The operation was aborted', 'AbortError');
      response?.destroy(error);
      request.destroy(error);
      fail(error);
    };

    // Absolute wall-clock deadline: continuous streaming cannot reset this.
    const absoluteTimer = setTimeout(() => {
      const err = new Error(`Outbound request absolute deadline exceeded after ${timeoutMs}ms`);
      request.destroy(err);
      fail(err);
    }, timeoutMs);

    // options.timeout is the socket idle timeout; absoluteTimer is the hard bound.
    const request = lib.request(options, (res) => {
      response = res;
      responseMeta = {
        headers: res.headers as Record<string, string | string[] | undefined>,
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
      };

      res.on('data', (chunk: Buffer | string) => {
        if (settled || truncated) return;

        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxResponseBytes - total;

        // Overflow only: a chunk that exactly fills the budget is accepted
        // without marking truncated; a later non-empty chunk is overflow.
        if (buf.length > remaining) {
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
    });

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

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    if (body && body.length > 0) {
      request.write(body);
    }
    request.end();
  });
};

/** Streaming variant for MCP Streamable HTTP/SSE with DNS pinning and abort propagation. */
export const defaultPinnedStreamingTransport = (
  req: PinnedTransportRequest & { signal?: AbortSignal | null },
): Promise<Response> => {
  const { body, timeoutMs, maxResponseBytes, signal } = req;
  const { lib, options } = buildPinnedRequestOptions(req);

  return new Promise((resolve, reject) => {
    let response: http.IncomingMessage | undefined;
    let limiter: Transform | undefined;
    let responseDelivered = false;
    let terminated = false;
    let bodyClosed = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let detachBodyListeners = () => {};
    const abortError = () => new DOMException('The operation was aborted', 'AbortError');
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const destroyAll = (error?: Error, bodyCanceled = false) => {
      if (terminated) return;
      terminated = true;
      if (!bodyCanceled && error && !bodyClosed) {
        bodyClosed = true;
        try {
          bodyController?.error(error);
        } catch {
          // The Web stream may already be closing concurrently.
        }
      }
      detachBodyListeners();
      response?.unpipe(limiter);
      limiter?.destroy(error);
      response?.destroy(error);
      request.destroy(error);
      cleanup();
    };
    const fail = (error: Error) => {
      destroyAll(error);
      if (!responseDelivered) reject(error);
    };
    const onAbort = () => {
      fail(abortError());
    };
    const timer = setTimeout(() => {
      fail(new Error(`Outbound request absolute deadline exceeded after ${timeoutMs}ms`));
    }, timeoutMs);
    const request = lib.request(options, (incoming) => {
      try {
        response = incoming;
        const status = incoming.statusCode ?? 500;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else {
            responseHeaders.set(key, value);
          }
        }
        if (NO_BODY_RESPONSE_STATUSES.has(status)) {
          // Undici rejects a non-null body for these statuses. Cut off even a
          // malicious peer that keeps sending bytes, then return a bodyless response.
          destroyAll();
          const bodyless = new Response(null, {
            headers: responseHeaders,
            status,
            statusText: incoming.statusMessage,
          });
          responseDelivered = true;
          resolve(bodyless);
          return;
        }
        let total = 0;
        limiter = new Transform({
          transform(chunk: Buffer | string, _encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.length;
            if (total > maxResponseBytes) {
              const error = new Error('Outbound streaming response exceeded byte limit');
              callback(error);
              destroyAll(error);
              return;
            }
            callback(null, bytes);
          },
        });
        incoming.pipe(limiter);
        incoming.once('error', (error) => limiter?.destroy(error));
        limiter.once('end', cleanup);
        limiter.once('error', (error) => {
          if (!terminated) destroyAll(error);
        });
        limiter.once('close', () => {
          // ReadableStream.cancel() destroys the Transform. Explicitly tear down
          // the upstream IncomingMessage and ClientRequest as well, including
          // redirect and SDK early-cancel paths.
          if (!incoming.complete && !terminated) destroyAll();
          else cleanup();
        });
        const responseBody = new ReadableStream<Uint8Array>({
          cancel(reason) {
            bodyClosed = true;
            destroyAll(reason instanceof Error ? reason : abortError(), true);
          },
          pull() {
            limiter?.resume();
          },
          start(controller) {
            bodyController = controller;
            const onData = (chunk: Buffer | string) => {
              if (bodyClosed) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              controller.enqueue(new Uint8Array(bytes));
              if ((controller.desiredSize ?? 1) <= 0) limiter?.pause();
            };
            const onEnd = () => {
              if (bodyClosed) return;
              bodyClosed = true;
              controller.close();
              cleanup();
            };
            const onError = (error: Error) => destroyAll(error);
            limiter!.on('data', onData);
            limiter!.once('end', onEnd);
            limiter!.once('error', onError);
            detachBodyListeners = () => {
              limiter?.off('data', onData);
              limiter?.off('end', onEnd);
              limiter?.off('error', onError);
            };
          },
        });
        const streamed = new Response(responseBody, {
          headers: responseHeaders,
          status,
          statusText: incoming.statusMessage,
        });
        responseDelivered = true;
        resolve(streamed);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Outbound response construction failed'));
      }
    });
    request.once('error', (error) => {
      if (!responseDelivered) fail(error);
      else if (!terminated) limiter?.destroy(error);
    });
    request.once('timeout', () => request.destroy(new Error('Outbound request idle timed out')));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (body?.length) request.write(body);
    request.end();
  });
};
