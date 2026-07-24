import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';

import type {
  DnsResolver,
  PinnedTransport,
  PinnedTransportRequest,
  PinnedTransportResponse,
  ResolvedAddress,
} from './types';

const NO_BODY_RESPONSE_STATUSES = new Set([204, 205, 304]);

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
  const { url, pinnedAddress, family, method, headers, body, timeoutMs, maxResponseBytes, signal } =
    req;
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
  const { url, pinnedAddress, family, method, headers, body, timeoutMs, maxResponseBytes, signal } =
    req;
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

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
    const request = lib.request(
      {
        family,
        headers: { ...headers, Host: url.host },
        hostname: pinnedAddress,
        method,
        path: `${url.pathname}${url.search}`,
        port,
        servername: isHttps ? url.hostname : undefined,
        timeout: timeoutMs,
      },
      (incoming) => {
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
      },
    );
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
